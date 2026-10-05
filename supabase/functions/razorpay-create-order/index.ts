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

import { audit, authenticate } from '../_shared/authorize.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RAZORPAY_KEY_ID = Deno.env.get('RAZORPAY_KEY_ID')!;
const RAZORPAY_KEY_SECRET = Deno.env.get('RAZORPAY_KEY_SECRET')!;

// Only our own site may call this from a browser (set ALLOWED_ORIGIN as a function
// secret to allow e.g. http://localhost:5173 in a dev project).
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? 'https://www.sanjeevnios.in';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Vary': 'Origin',
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

  // 1. WHO - a real, unexpired user session (see _shared/authorize.ts).
  const auth = await authenticate(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const { caller } = auth;

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

  // 4. THIS RESOURCE - loaded as the caller, so row-level security applies:
  // a booking that isn't theirs comes back as "not found", never as data.
  const { data: appointment, error: apptError } = await caller.client
    .from('appointments')
    .select('id, family_members(account_id)')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptError || !appointment) {
    return json({ error: 'Appointment not found.' }, 404);
  }
  // 3. ALLOWED - paying for a visit is the patient's own action. The clinic
  // can see this booking too, but it doesn't get to pay for it.
  // A to-one embed; PostgREST has returned it as an object or a one-item
  // array depending on version (see AdminBilling.tsx's oneSubscription()).
  const member = appointment.family_members as unknown as { account_id: string } | { account_id: string }[] | null;
  const bookedBy = Array.isArray(member) ? member[0]?.account_id : member?.account_id;
  if (!caller.isAdmin && bookedBy !== caller.user.id) {
    return json({ error: 'Only the patient who made this booking can pay for it.' }, 403);
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

  // 6. Audit.
  await audit(serviceClient, caller, 'payment_order_created', appointmentId);
  return json({ orderId: order.id, amount: order.amount, keyId: RAZORPAY_KEY_ID });
});
