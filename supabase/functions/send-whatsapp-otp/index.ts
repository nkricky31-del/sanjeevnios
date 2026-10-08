// supabase/functions/send-whatsapp-otp/index.ts
//
// Supabase Auth "Send SMS" hook. Supabase generates, stores (hashed) and later
// verifies the OTP; this function only DELIVERS it, through MSG91, then reports
// success or failure back so signInWithOtp() surfaces a real error.
//
// Channel (secret OTP_CHANNEL):
//   whatsapp          WhatsApp authentication template only
//   sms               MSG91 SMS OTP only (needs DLT registration in India)
//   whatsapp_then_sms (default) WhatsApp first, SMS if WhatsApp fails
//
// Safety, in order:
//   1. The request must carry Supabase's webhook signature (this endpoint is
//      public: --no-verify-jwt). Unsigned/forged calls get 401 and cost nothing.
//   2. Indian mobile numbers only (+91 [6-9]xxxxxxxxx). Blocks SMS-pumping to
//      premium/international numbers, the usual way OTP bills get abused.
//   3. At most 5 codes per phone per hour and OTP_DAILY_CAP (default 3000)
//      sends per day for the whole project - a hard ceiling on the MSG91 bill.
//   4. The OTP and the full phone number are never written to logs.
//
// Deploy (ALWAYS with the flag - without it every login fails with 401):
//   npx supabase functions deploy send-whatsapp-otp --no-verify-jwt
//   (scripts/deploy-functions.sh does this for you after deploying the rest)
// Secrets:
//   npx supabase secrets set \
//     SEND_SMS_HOOK_SECRET='v1,whsec_...'  MSG91_AUTH_KEY=...  \
//     MSG91_WHATSAPP_SENDER=91XXXXXXXXXX    MSG91_WHATSAPP_TEMPLATE_NAME=...  \
//     MSG91_SMS_TEMPLATE_ID=...             OTP_CHANNEL=whatsapp_then_sms
// Optional: MSG91_WHATSAPP_BUTTON=1 (authentication template with a copy-code
//   button), MSG91_WHATSAPP_LANG=en, OTP_DAILY_CAP=3000.
// Dashboard: Authentication > Hooks > Send SMS hook > HTTPS > this function's URL.
import { Webhook } from 'npm:standardwebhooks@1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Supabase shows the secret as "v1,whsec_<base64>"; the library wants the base64 part.
const HOOK_SECRET = (Deno.env.get('SEND_SMS_HOOK_SECRET') ?? '').replace('v1,whsec_', '');

const MSG91_AUTH_KEY = Deno.env.get('MSG91_AUTH_KEY');
const WA_ENDPOINT = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
const WA_SENDER = Deno.env.get('MSG91_WHATSAPP_SENDER');
const WA_TEMPLATE = Deno.env.get('MSG91_WHATSAPP_TEMPLATE_NAME');
const WA_LANG = Deno.env.get('MSG91_WHATSAPP_LANG') ?? 'en';
const WA_BUTTON = Deno.env.get('MSG91_WHATSAPP_BUTTON') === '1';
const SMS_ENDPOINT = 'https://control.msg91.com/api/v5/otp';
const SMS_TEMPLATE_ID = Deno.env.get('MSG91_SMS_TEMPLATE_ID');
const CHANNEL = Deno.env.get('OTP_CHANNEL') ?? 'whatsapp_then_sms';
const DAILY_CAP = Number(Deno.env.get('OTP_DAILY_CAP') ?? '3000');

// Supabase gives a Send-SMS hook only 5 seconds in total. Every outbound call
// below has its own shorter deadline so we always answer in time.
const MSG91_TIMEOUT_MS = 2500;
const COUNTER_TIMEOUT_MS = 1200;

const INDIA_MOBILE = /^\+91[6-9]\d{9}$/;

// Supabase turns a non-2xx with this body into the error signInWithOtp() returns.
function fail(httpCode: number, message: string) {
  return new Response(JSON.stringify({ error: { http_code: httpCode, message } }), {
    status: httpCode,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sendWhatsApp(phone: string, otp: string): Promise<boolean> {
  if (!MSG91_AUTH_KEY || !WA_SENDER || !WA_TEMPLATE) return false;
  const components: Record<string, unknown> = { body_1: { type: 'text', value: otp } };
  if (WA_BUTTON) components.button_1 = { subtype: 'url', type: 'text', value: otp };
  const res = await fetch(WA_ENDPOINT, {
    signal: AbortSignal.timeout(MSG91_TIMEOUT_MS),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey: MSG91_AUTH_KEY },
    body: JSON.stringify({
      integrated_number: WA_SENDER,
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          name: WA_TEMPLATE,
          language: { code: WA_LANG, policy: 'deterministic' },
          namespace: null,
          to_and_components: [{ to: [phone.replace('+', '')], components }],
        },
      },
    }),
  });
  if (!res.ok) {
    console.error('MSG91 WhatsApp failed', res.status, (await res.text()).slice(0, 300));
    return false;
  }
  return true;
}

async function sendSms(phone: string, otp: string): Promise<boolean> {
  if (!MSG91_AUTH_KEY || !SMS_TEMPLATE_ID) return false;
  const url = new URL(SMS_ENDPOINT);
  url.searchParams.set('template_id', SMS_TEMPLATE_ID);
  url.searchParams.set('mobile', phone.replace('+', ''));
  url.searchParams.set('otp', otp);
  const res = await fetch(url, { signal: AbortSignal.timeout(MSG91_TIMEOUT_MS), method: 'POST', headers: { authkey: MSG91_AUTH_KEY, 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.type === 'error') {
    console.error('MSG91 SMS failed', res.status, JSON.stringify(body).slice(0, 300));
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return fail(405, 'Method not allowed.');

  // 1. Signature
  const payload = await req.text();
  let event: { user?: { phone?: string }; sms?: { otp?: string } };
  try {
    event = new Webhook(HOOK_SECRET).verify(payload, Object.fromEntries(req.headers)) as typeof event;
  } catch {
    return fail(401, 'Invalid signature.');
  }
  const phone = event.user?.phone ? (event.user.phone.startsWith('+') ? event.user.phone : `+${event.user.phone}`) : '';
  const otp = event.sms?.otp ?? '';
  if (!/^\d{4,8}$/.test(otp)) return fail(400, 'Bad request.');

  // 2. Indian mobiles only
  if (!INDIA_MOBILE.test(phone)) return fail(400, 'Only Indian mobile numbers are supported.');

  // 3. Caps. Plain fetch to the database function (no heavy client library = fast
  //    cold start). Fails open on error/timeout: a login must not break because
  //    the counter was slow, and the daily cap still bounds the normal case.
  try {
    const phoneKey = await sha256Hex(phone);
    const bump = async (bucket: string, limit: number, window: number) => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/edge_rate_limit`, {
        method: 'POST',
        signal: AbortSignal.timeout(COUNTER_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ p_bucket: bucket, p_limit: limit, p_window: window }),
      });
      return r.ok ? await r.json() : null; // number of seconds to wait, or null
    };
    const [perPhone, global] = await Promise.all([
      bump(`otp:phone:${phoneKey}`, 5, 3600),
      bump('otp:global', DAILY_CAP, 86400),
    ]);
    if (typeof perPhone === 'number') return fail(429, 'Too many codes requested. Try again in an hour.');
    if (typeof global === 'number') return fail(429, 'We are receiving too many requests. Please try again later.');
  } catch (e) {
    console.error('otp rate limit check failed (allowing):', String(e).slice(0, 120));
  }

  // 4. Deliver
  let sent = false;
  if (CHANNEL === 'sms') {
    sent = await sendSms(phone, otp);
  } else if (CHANNEL === 'whatsapp') {
    sent = await sendWhatsApp(phone, otp);
  } else {
    sent = (await sendWhatsApp(phone, otp)) || (await sendSms(phone, otp));
  }
  if (!sent) return fail(500, 'We could not send your code. Please try again in a minute.');

  return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
