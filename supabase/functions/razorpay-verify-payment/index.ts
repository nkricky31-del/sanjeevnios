// supabase/functions/razorpay-verify-payment/index.ts
//
// Called right after Razorpay Checkout's success handler fires client-side.
// Checkout's callback data is NOT proof of payment by itself - anyone could
// forge a fake success callback in the browser - so this recomputes
// Razorpay's HMAC signature server-side (the one documented step that
// actually proves the payment_id genuinely belongs to the order_id Razorpay
// issued) before the app is allowed to treat this booking as paid.
//
// This does not capture anything - the order was created with
// payment_capture: 0 (see razorpay-create-order), so at this point Razorpay
// has only authorized the amount. It stays authorized (held) until
// razorpay-capture-payment actually captures it, on Accept.
//
// Deploy: npx supabase functions deploy razorpay-verify-payment
// Secrets: shares RAZORPAY_KEY_SECRET with the other razorpay-* functions.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ verified: false, error: 'Missing Authorization header.' }, 401);

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

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: appointment, error: apptError } = await callerClient
    .from('appointments')
    .select('id')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptError || !appointment) {
    return json({ verified: false, error: 'Appointment not visible to caller.' }, 403);
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: payment, error: paymentError } = await serviceClient
    .from('payments')
    .select('id, status, razorpay_order_id')
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

  const { error: updateError } = await serviceClient
    .from('payments')
    .update({ razorpay_payment_id: razorpayPaymentId })
    .eq('id', payment.id);
  if (updateError) {
    return json({ verified: false, error: `Verified but could not be saved: ${updateError.message}` }, 500);
  }

  return json({ verified: true });
});
