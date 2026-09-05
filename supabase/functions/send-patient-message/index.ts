// supabase/functions/send-patient-message/index.ts
//
// The WhatsApp/SMS leg of the two-step confirmation flow (see
// migration_39_two_step_confirmation_notifications.sql and src/lib/notify.ts).
// The in-app notification (the `notifications` table) is always written
// first and is never conditional on this function - this is strictly the
// "AND (if configured) a WhatsApp/SMS" half.
//
// Deliberately generic rather than wired to one gateway: it looks for the
// same MSG91 WhatsApp secrets described in WHATSAPP_OTP_MSG91.md (that doc
// covers OTP delivery only - this reuses the same account/template
// mechanics for the three lifecycle messages instead). If those secrets
// aren't set, it reports back { sent: false, skipped: true } and does
// nothing else - "if configured" is enforced right here, not by the caller.
//
// Deploy with:
//   npx supabase functions deploy send-patient-message
// Configure (optional - omit all three and this function just no-ops):
//   npx supabase secrets set MSG91_AUTH_KEY=... MSG91_WHATSAPP_SENDER=... MSG91_WHATSAPP_TEMPLATE_NAME=...
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MSG91_AUTH_KEY = Deno.env.get('MSG91_AUTH_KEY');
const MSG91_WHATSAPP_SENDER = Deno.env.get('MSG91_WHATSAPP_SENDER');
const MSG91_WHATSAPP_TEMPLATE_NAME = Deno.env.get('MSG91_WHATSAPP_TEMPLATE_NAME');
// See WHATSAPP_OTP_MSG91.md Step 2 - get this exact endpoint + body shape
// from your own MSG91 dashboard's "API" panel rather than trusting a
// hardcoded URL, since MSG91's exact request shape has changed across API
// versions.
const MSG91_ENDPOINT = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ sent: false, error: 'Missing Authorization header.' }, 401);

  let body: { userId?: string; appointmentId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return json({ sent: false, error: 'Invalid JSON body.' }, 400);
  }
  const { userId, appointmentId, message } = body;
  if (!userId || !appointmentId || !message) {
    return json({ sent: false, error: 'userId, appointmentId and message are required.' }, 400);
  }

  // Runs as the calling user (their own JWT, RLS still enforced) purely to
  // confirm they're allowed to see this appointment at all - the same
  // ownership chain log_notification() already checked before this function
  // was ever called. This does NOT re-derive the phone number - that needs
  // the service-role client below, since a clinic has no RLS access to a
  // patient's own profile.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: appointment, error: apptError } = await callerClient
    .from('appointments')
    .select('id')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptError || !appointment) {
    return json({ sent: false, error: 'Appointment not visible to caller.' }, 403);
  }

  if (!MSG91_AUTH_KEY || !MSG91_WHATSAPP_SENDER || !MSG91_WHATSAPP_TEMPLATE_NAME) {
    return json({ sent: false, skipped: true, reason: 'not_configured' });
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile } = await serviceClient.from('profiles').select('phone').eq('id', userId).maybeSingle();
  const phone = profile?.phone;
  if (!phone) {
    return json({ sent: false, skipped: true, reason: 'no_phone_on_file' });
  }

  try {
    const res = await fetch(MSG91_ENDPOINT, {
      method: 'POST',
      headers: { authkey: MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integrated_number: MSG91_WHATSAPP_SENDER,
        content_type: 'template',
        payload: {
          messaging_product: 'whatsapp',
          type: 'template',
          template: {
            name: MSG91_WHATSAPP_TEMPLATE_NAME,
            // The exact variable shape depends on your approved template -
            // this assumes a single free-text body variable, adjust to
            // match what your template actually declares.
            language: { code: 'en', policy: 'deterministic' },
            to_and_components: [{ to: [phone], components: { body_1: { type: 'text', value: message } } }],
          },
        },
      }),
    });
    if (!res.ok) {
      return json({ sent: false, error: `MSG91 responded ${res.status}` }, 502);
    }
    return json({ sent: true, channel: 'whatsapp' });
  } catch (err) {
    return json({ sent: false, error: String(err) }, 502);
  }
});
