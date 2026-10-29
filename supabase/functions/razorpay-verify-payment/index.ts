// supabase/functions/razorpay-verify-payment/index.ts
//
// Called right after Razorpay Checkout's success handler fires client-side.
// Checkout's callback data is NOT proof of payment by itself - anyone could
// forge a fake success callback in the browser - so this recomputes
// Razorpay's HMAC signature server-side (the one documented step that
// actually proves the payment_id genuinely belongs to the order_id Razorpay
// issued) before the app is allowed to treat this booking as paid.
//
// Bookings are confirmed the moment they're made (migration 85 - there is no
// clinic Accept step any more), so once the signature checks out this also
// CAPTURES the payment: the order was created with payment_capture: 0 (see
// razorpay-create-order), so until now Razorpay had only authorised it. Only
// after Razorpay confirms the capture is the booking recorded as paid
// (record_online_payment_captured). If the capture fails, nothing is charged
// and the app cancels the booking - the authorisation lapses on its own.
//
// Deploy: npx supabase functions deploy razorpay-verify-payment
// Secrets: shares RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET with the other razorpay-* functions.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { audit, authenticate } from '../_shared/authorize.ts';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RAZORPAY_KEY_ID = Deno.env.get('RAZORPAY_KEY_ID')!;
const RAZORPAY_KEY_SECRET = Deno.env.get('RAZORPAY_KEY_SECRET')!;

// The allowed origin is added per request (website or app): _shared/cors.ts.
const CORS_HEADERS = {
  'Vary': 'Origin',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(withCors(CORS_HEADERS, async (req) => {
  // 1. WHO - a real, unexpired user session (see _shared/authorize.ts).
  const auth = await authenticate(req);
  if (!auth.ok) return json({ verified: false, error: auth.error }, auth.status);
  const { caller } = auth;

  let body: {
    appointmentId?: string;
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    razorpaySignature?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ verified: false, error: 'Invalid JSON body.' }, 400);
  }
  const { appointmentId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = body;
  if (!appointmentId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return json({ verified: false, error: 'appointmentId, razorpayOrderId, razorpayPaymentId and razorpaySignature are all required.' }, 400);
  }

  // 4. THIS RESOURCE - loaded as the caller, so row-level security applies:
  // a booking that isn't theirs comes back as "not found", never as data.
  const { data: appointment, error: apptError } = await caller.client
    .from('appointments')
    .select('id, family_members(account_id)')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptError || !appointment) {
    return json({ verified: false, error: 'Appointment not found.' }, 404);
  }
  // 3. ALLOWED - paying for a visit is the patient's own action. The clinic
  // can see this booking too, but it doesn't get to pay for it.
  // A to-one embed; PostgREST has returned it as an object or a one-item
  // array depending on version (see AdminBilling.tsx's oneSubscription()).
  const member = appointment.family_members as unknown as { account_id: string } | { account_id: string }[] | null;
  const bookedBy = Array.isArray(member) ? member[0]?.account_id : member?.account_id;
  if (!caller.isAdmin && bookedBy !== caller.user.id) {
    return json({ verified: false, error: 'Only the patient who made this booking can pay for it.' }, 403);
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: payment, error: paymentError } = await serviceClient
    .from('payments')
    .select('id, status, razorpay_order_id, net_amount, amount')
    .eq('appointment_id', appointmentId)
    .maybeSingle();
  if (paymentError || !payment) {
    return json({ verified: false, error: 'No payment record found for this appointment.' }, 404);
  }
  if (payment.razorpay_order_id !== razorpayOrderId) {
    return json({ verified: false, error: 'Order id does not match this booking.' }, 400);
  }
  if (payment.status !== 'hold') {
    // Already verified (or already resolved some other way) - report success
    // without redoing anything, so a retried client call is harmless.
    return json({ verified: true, alreadyVerified: true });
  }

  const expectedSignature = await hmacHex(RAZORPAY_KEY_SECRET, `${razorpayOrderId}|${razorpayPaymentId}`);
  if (expectedSignature !== razorpaySignature) {
    return json({ verified: false, error: 'Payment signature did not match - this callback could not be trusted.' }, 400);
  }

  // The booking may have been released while the patient was paying (the
  // abandoned-checkout sweep, migration 85). Don't take money for it.
  const { data: liveAppt } = await serviceClient
    .from('appointments')
    .select('status')
    .eq('id', appointmentId)
    .maybeSingle();
  if (!liveAppt || liveAppt.status === 'cancelled' || liveAppt.status === 'rejected') {
    return json(
      {
        verified: false,
        error: 'This booking was released before the payment finished, so nothing has been charged. Your bank will release the amount. Please book again.',
      },
      409
    );
  }

  // Capture now - see this file's header.
  const amountPaise = Math.round(Number(payment.net_amount ?? payment.amount) * 100);
  const captureRes = await fetch(`https://api.razorpay.com/v1/payments/${razorpayPaymentId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR' }),
  });
  if (!captureRes.ok) {
    const detail = await captureRes.text();
    // A retried call after a capture that already went through is fine.
    if (!/already been captured/i.test(detail)) {
      return json({ verified: false, error: `The payment could not be completed: ${detail}` }, 502);
    }
  }

  const { error: recordError } = await serviceClient.rpc('record_online_payment_captured', {
    p_appointment_id: appointmentId,
    p_razorpay_payment_id: razorpayPaymentId,
  });
  if (recordError) {
    // The money HAS been captured - never tell the app to cancel the booking
    // now. Keep it confirmed and leave an audit trail for an admin to fix the
    // ledger by hand.
    await audit(serviceClient, caller, 'payment_captured_unrecorded', appointmentId);
    return json({ verified: true, captured: true, warning: `Payment taken, ledger not updated: ${recordError.message}` });
  }

  // 6. Audit.
  await audit(serviceClient, caller, 'payment_captured', appointmentId);
  return json({ verified: true, captured: true });
}));
