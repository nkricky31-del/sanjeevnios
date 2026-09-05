// supabase/functions/razorpay-create-order/index.ts
//
// Creates the Razorpay order that becomes the HOLD (Part 46 / migration 41):
// payment_capture: 0 means Razorpay authorizes the amount on the patient's
// card/UPI but does not move any money yet - exactly the "place a hold, do
// not charge yet" requirement. The actual charge only happens later, for
// real, in razorpay-capture-payment.
//
// All Razorpay secret work lives here and in the other two razorpay-* functions
// - the app never sees RAZORPAY_KEY_SECRET, only the public key id this
// function hands back for Checkout.js to open with.
//
// Deploy: npx supabase functions deploy razorpay-create-order
// Secrets: npx supabase secrets set RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=...
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
  if (!authHeader) return json({ error: 'Missing Authorization header.' }, 401);

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return json({ error: 'Online payment is not configured on this server yet.' }, 503);
  }

  let body: { appointmentId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const { appointmentId } = body;
  if (!appointmentId) return json({ error: 'appointmentId is required.' }, 400);

  // Runs as the calling user - proves they can actually see this appointment
  // (appointments_select RLS: their own booking, or their own clinic) before
  // anything else happens.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: appointment, error: apptError } = await callerClient
    .from('appointments')
    .select('id')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptError || !appointment) {
    return json({ error: 'Appointment not visible to caller.' }, 403);
  }

  // Service role from here - reading/writing the payments row's Razorpay
  // fields is not something ordinary RLS grants the client, and shouldn't:
  // the net_amount below is what actually gets charged, so it is read from
  // the database (already computed authoritatively by
  // create_payment_with_coupon()), never accepted from the request body.
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: payment, error: paymentError } = await serviceClient
    .from('payments')
    .select('id, method, status, net_amount, razorpay_order_id')
    .eq('appointment_id', appointmentId)
    .maybeSingle();
  if (paymentError || !payment) {
    return json({ error: 'No payment record found for this appointment.' }, 404);
  }
  if (payment.method !== 'online') {
    return json({ error: 'This booking is not an online payment.' }, 400);
  }
  if (payment.status !== 'hold') {
    return json({ error: `This payment is already ${payment.status} - cannot create a new order.` }, 409);
  }
  // Idempotency: a retried request (e.g. a flaky network on the first
  // attempt) reuses the same order rather than authorizing the patient's
  // card twice.
  if (payment.razorpay_order_id) {
    return json({ orderId: payment.razorpay_order_id, amount: Math.round(payment.net_amount * 100), keyId: RAZORPAY_KEY_ID });
  }
  if (!payment.net_amount || payment.net_amount <= 0) {
    return json({ error: 'This payment has no valid amount to charge.' }, 400);
  }

  const amountPaise = Math.round(payment.net_amount * 100);

  const orderRes = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      // The hold itself - see this function's header comment.
      payment_capture: 0,
      receipt: appointmentId,
      notes: { appointment_id: appointmentId },
    }),
  });
  if (!orderRes.ok) {
    const detail = await orderRes.text();
    return json({ error: `Razorpay order creation failed: ${detail}` }, 502);
  }
  const order = (await orderRes.json()) as { id: string; amount: number };

  const { error: updateError } = await serviceClient
    .from('payments')
    .update({ razorpay_order_id: order.id })
    .eq('id', payment.id);
  if (updateError) {
    return json({ error: `Order created but could not be saved: ${updateError.message}` }, 500);
  }

  return json({ orderId: order.id, amount: order.amount, keyId: RAZORPAY_KEY_ID });
});
