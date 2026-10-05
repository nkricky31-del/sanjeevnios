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

import { audit, authenticate } from '../_shared/authorize.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
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

  // 1. WHO - a real, unexpired user session (see _shared/authorize.ts).
  const auth = await authenticate(req);
  if (!auth.ok) return json({ sent: false, error: auth.error }, auth.status);
  const { caller } = auth;

  // userId is still accepted for older app builds but no longer trusted: the
  // recipient is always the appointment's own patient (step 4 below).
  let body: { userId?: string; appointmentId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return json({ sent: false, error: 'Invalid JSON body.' }, 400);
  }
  const { appointmentId, message } = body;
  if (!appointmentId || !message) {
    return json({ sent: false, error: 'appointmentId and message are required.' }, 400);
  }

  // 4. THIS RESOURCE - loaded as the caller (row-level security), so an
  // appointment they can't see is "not found".
  const { data: appointment, error: apptError } = await caller.client
    .from('appointments')
    .select('id, clinic_id, member_id')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptError || !appointment) {
    return json({ sent: false, error: 'Appointment not found.' }, 404);
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  // The recipient comes from the appointment itself - never from the request
  // body - so this can only ever message the patient this booking is for.
  const { data: member } = await serviceClient
    .from('family_members')
    .select('account_id')
    .eq('id', appointment.member_id)
    .maybeSingle();
  const recipientId = member?.account_id as string | undefined;
  if (!recipientId) {
    return json({ sent: false, error: 'Appointment not found.' }, 404);
  }

  // 2 + 3. WHICH CLINIC / ALLOWED - the appointment's own clinic (from the
  // caller's membership), the patient themselves, or an admin.
  const isOwnClinic = !!caller.clinicId && caller.clinicId === appointment.clinic_id;
  if (!caller.isAdmin && !isOwnClinic && caller.user.id !== recipientId) {
    return json({ sent: false, error: 'Not allowed to message this patient.' }, 403);
  }

  if (!MSG91_AUTH_KEY || !MSG91_WHATSAPP_SENDER || !MSG91_WHATSAPP_TEMPLATE_NAME) {
    return json({ sent: false, skipped: true, reason: 'not_configured' });
  }

  const { data: profile } = await serviceClient.from('profiles').select('phone').eq('id', recipientId).maybeSingle();
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
    // 6. Audit.
    await audit(serviceClient, caller, 'patient_message_sent', appointmentId);
    return json({ sent: true, channel: 'whatsapp' });
  } catch (err) {
    return json({ sent: false, error: String(err) }, 502);
  }
});
