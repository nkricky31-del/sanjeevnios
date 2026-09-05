// supabase/functions/razorpay-capture-payment/index.ts
//
// The real money-moving step, called from ClinicQueue.tsx's acceptAppointment
// BEFORE the appointment's status is set to 'accepted' - only once this
// function reports success does the client flip the status, so the local
// database can never show "accepted" while Razorpay disagrees about the
// money. The status flip's own trigger (handle_appointment_status_change)
// then does the matching LOCAL bookkeeping (payments.status: hold ->
// captured, and confirms any coupon redemption) - this function's only job
// is the actual Razorpay API call.
//
// A COD booking, or an online one with nothing left to capture (already
// captured, or never got a verified Razorpay payment id), is reported as a
// no-op success so the caller's accept flow doesn't need two branches.
//
// Deploy: npx supabase functions deploy razorpay-capture-payment
// Secrets: shares RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET with the other razorpay-* functions.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RAZORPAY_KEY_ID = Deno.env.get('RAZORPAY_KEY_ID')!;
const RAZORPAY_KEY_SECRET = Deno.env.get('RAZORPAY_KEY_SECRET')!;

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

function basicAuthHeader(): string {
  return 'Basic ' + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ captured: false, error: 'Missing Authorization header.' }, 401);

  let body: { appointmentId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ captured: false, error: 'Invalid JSON body.' }, 400);
  }
  const { appointmentId } = body;
  if (!appointmentId) return json({ captured: false, error: 'appointmentId is required.' }, 400);

  // Only the clinic that owns this appointment (or an admin) may capture its
  // payment - reuses the same is_own_clinic() check the rest of the app's
  // clinic-only RPCs already rely on, run as the caller so it's their own
  // membership being checked, not this function's.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: appointment, error: apptError } = await callerClient
    .from('appointments')
    .select('id, clinic_id')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptError || !appointment) {
    return json({ captured: false, error: 'Appointment not visible to caller.' }, 403);
  }
  const { data: isAdmin } = await callerClient.rpc('is_admin');
  const { data: isOwnClinic } = await callerClient.rpc('is_own_clinic', { target_clinic_id: appointment.clinic_id });
  if (!isAdmin && !isOwnClinic) {
    return json({ captured: false, error: 'Only the clinic can capture this payment.' }, 403);
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: payment, error: paymentError } = await serviceClient
    .from('payments')
    .select('id, method, status, net_amount, razorpay_payment_id')
    .eq('appointment_id', appointmentId)
    .maybeSingle();
  if (paymentError || !payment) {
    return json({ captured: false, error: 'No payment record found for this appointment.' }, 404);
  }

  // Nothing to do: COD, already captured/refunded, or the patient's
  // Razorpay payment was never verified (checkout abandoned) - the caller
  // proceeds with accepting the appointment either way.
  if (payment.method !== 'online' || payment.status !== 'hold' || !payment.razorpay_payment_id) {
    return json({ captured: true, skipped: true });
  }

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return json({ captured: false, error: 'Online payment is not configured on this server.' }, 503);
  }

  const amountPaise = Math.round(payment.net_amount * 100);
  const captureRes = await fetch(`https://api.razorpay.com/v1/payments/${payment.razorpay_payment_id}/capture`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR' }),
  });
  if (!captureRes.ok) {
    const detail = await captureRes.text();
    return json({ captured: false, error: `Razorpay capture failed: ${detail}` }, 502);
  }

  return json({ captured: true });
});
