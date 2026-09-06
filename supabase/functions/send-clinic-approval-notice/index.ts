// supabase/functions/send-clinic-approval-notice/index.ts
//
// Fired once, by AdminConsole.tsx's approveClinic(), right after a clinic's
// status flips to 'approved' and migration_57_clinic_login_id.sql's trigger
// has minted its clinic_code. Delivers that Clinic ID by SMS (to the
// clinic's own registered phone) and email (to clinics.contact_email, if the
// clinic has one on file) - the in-app notification (the `notifications`
// table, via recordAdminDecision()) is always written first and is never
// conditional on this function, same split send-patient-message already
// uses for the patient side.
//
// Deliberately generic rather than wired to one gateway, same "if configured"
// contract as send-patient-message: each channel below independently no-ops
// (reported back as skipped, never an error) when its own secrets aren't
// set, so this function is safe to call with nothing configured at all.
//
// Deploy with:
//   npx supabase functions deploy send-clinic-approval-notice
// Configure (optional per channel - omit either group and that channel just skips):
//   SMS (MSG91 Flow API - a DLT-registered template is a hard legal
//   requirement for transactional SMS in India, there is no freeform-text
//   fallback):
//     npx supabase secrets set MSG91_AUTH_KEY=... MSG91_SMS_TEMPLATE_ID=...
//   Email (Resend - swap the fetch call below for any other provider's API,
//   the "optional, no-op if unset" shape is what matters, not the vendor):
//     npx supabase secrets set RESEND_API_KEY=... RESEND_FROM_EMAIL="SanjeevniOS <noreply@yourdomain>"
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MSG91_AUTH_KEY = Deno.env.get('MSG91_AUTH_KEY');
const MSG91_SMS_TEMPLATE_ID = Deno.env.get('MSG91_SMS_TEMPLATE_ID');
// See WHATSAPP_OTP_MSG91.md's own note on this - get the exact endpoint/body
// shape for your DLT template from MSG91's own "API" panel, this assumes the
// template declares exactly two variables (clinic name, then Clinic ID).
const MSG91_SMS_ENDPOINT = 'https://control.msg91.com/api/v5/flow/';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL');
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

interface ChannelResult {
  sent: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

async function sendSms(phone: string, clinicName: string, clinicCode: string): Promise<ChannelResult> {
  if (!MSG91_AUTH_KEY || !MSG91_SMS_TEMPLATE_ID) {
    return { sent: false, skipped: true, reason: 'not_configured' };
  }
  try {
    const res = await fetch(MSG91_SMS_ENDPOINT, {
      method: 'POST',
      headers: { authkey: MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_id: MSG91_SMS_TEMPLATE_ID,
        short_url: '0',
        recipients: [{ mobiles: phone, CLINIC_NAME: clinicName, CLINIC_CODE: clinicCode }],
      }),
    });
    if (!res.ok) return { sent: false, error: `MSG91 responded ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, error: String(err) };
  }
}

async function sendEmail(email: string, clinicName: string, clinicCode: string): Promise<ChannelResult> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    return { sent: false, skipped: true, reason: 'not_configured' };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [email],
        subject: `Your SanjeevniOS Clinic ID: ${clinicCode}`,
        html:
          `<p>Congratulations - <strong>${clinicName}</strong> has been approved on SanjeevniOS.</p>` +
          `<p>Your Clinic ID for logging in is:</p>` +
          `<p style="font-size:20px;font-weight:bold;letter-spacing:1px;">${clinicCode}</p>` +
          `<p>Staff sign in at the clinic login screen with this Clinic ID plus a phone number registered to your clinic, then a one-time code sent to that phone. Never share this Clinic ID as if it were a password by itself - it only works together with a registered phone.</p>`,
      }),
    });
    if (!res.ok) return { sent: false, error: `Resend responded ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, error: String(err) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header.' }, 401);

  let body: { clinicId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const { clinicId } = body;
  if (!clinicId) return json({ error: 'clinicId is required.' }, 400);

  // Only an admin may trigger this - runs as the calling user's own JWT,
  // same is_admin() RPC every other admin-only edge function already checks
  // (see razorpay-create-subscription for the identical pattern).
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: isAdmin } = await callerClient.rpc('is_admin');
  if (!isAdmin) return json({ error: 'Only an admin can send this.' }, 403);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: clinic, error: clinicError } = await serviceClient
    .from('clinics')
    .select('id, name, clinic_code, status, owner_id, contact_email')
    .eq('id', clinicId)
    .maybeSingle();
  if (clinicError || !clinic) return json({ error: 'Clinic not found.' }, 404);
  if (clinic.status !== 'approved' || !clinic.clinic_code) {
    return json({ error: 'This clinic has no Clinic ID yet - approve it first.' }, 400);
  }

  const { data: ownerProfile } = await serviceClient
    .from('profiles')
    .select('phone')
    .eq('id', clinic.owner_id)
    .maybeSingle();
  const smsPhone = ownerProfile?.phone ?? null;

  const [sms, email] = await Promise.all([
    smsPhone
      ? sendSms(smsPhone, clinic.name, clinic.clinic_code)
      : Promise.resolve<ChannelResult>({ sent: false, skipped: true, reason: 'no_phone_on_file' }),
    clinic.contact_email
      ? sendEmail(clinic.contact_email, clinic.name, clinic.clinic_code)
      : Promise.resolve<ChannelResult>({ sent: false, skipped: true, reason: 'no_email_on_file' }),
  ]);

  return json({ sms, email });
});
