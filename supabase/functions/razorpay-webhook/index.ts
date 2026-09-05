// supabase/functions/razorpay-webhook/index.ts
//
// The ONLY place billing state (subscriptions.billing_status/current_period_end,
// clinics.is_active) actually changes. razorpay-create-subscription only ever
// records which Razorpay subscription id belongs to which clinic - it never
// marks anything active, past_due, paid or failed. That is deliberate: a
// client-side "it worked" callback is not proof of anything (see
// razorpay-verify-payment's own comment on the same point for the one-off
// booking flow) - a signed server-to-server event from Razorpay is.
//
// Configure this in the Razorpay dashboard (Settings -> Webhooks) pointing
// at this function's URL, with these events enabled: subscription.charged,
// subscription.pending, subscription.halted. Razorpay signs every request
// with a WEBHOOK SECRET you set when creating the webhook there (NOT the
// same as RAZORPAY_KEY_SECRET) - copy it into RAZORPAY_WEBHOOK_SECRET below.
//
// Razorpay calls this with no Supabase session at all, so it must be
// deployed with JWT verification OFF:
//   npx supabase functions deploy razorpay-webhook --no-verify-jwt
// Secret: npx supabase secrets set RAZORPAY_WEBHOOK_SECRET=...
//
// "Short grace period" (see migration_43's header): subscription.pending
// marks the clinic past_due immediately but leaves it visible/bookable -
// Razorpay itself keeps retrying the charge on its own schedule. Only
// subscription.halted (Razorpay has exhausted every retry) actually hides
// the clinic. That retry window IS the grace period; nothing here invents a
// second one or needs a cron job to enforce it.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RAZORPAY_WEBHOOK_SECRET = Deno.env.get('RAZORPAY_WEBHOOK_SECRET')!;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

interface RazorpaySubscriptionEntity {
  id: string;
  current_start: number | null; // unix seconds
  current_end: number | null;
  notes?: { clinic_id?: string };
}
interface RazorpayPaymentEntity {
  id: string;
  amount: number; // paise
  status: string;
}
interface WebhookPayload {
  event: string;
  payload: {
    subscription?: { entity: RazorpaySubscriptionEntity };
    payment?: { entity: RazorpayPaymentEntity };
  };
}

function toIso(unixSeconds: number | null): string | null {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

Deno.serve(async (req) => {
  if (!RAZORPAY_WEBHOOK_SECRET) {
    return json({ error: 'Webhook secret is not configured on this server.' }, 503);
  }

  // The signature is computed over the exact raw bytes Razorpay sent - this
  // MUST be read as text before any JSON.parse, or the signature will never
  // match (JSON.stringify(JSON.parse(x)) is not guaranteed to equal x).
  const rawBody = await req.text();
  const signature = req.headers.get('X-Razorpay-Signature');
  if (!signature) return json({ error: 'Missing X-Razorpay-Signature header.' }, 400);

  const expected = await hmacHex(RAZORPAY_WEBHOOK_SECRET, rawBody);
  if (expected !== signature) {
    return json({ error: 'Signature did not match - this request was not trusted.' }, 400);
  }

  let event: WebhookPayload;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const sub = event.payload.subscription?.entity;
  if (!sub) {
    // Not every Razorpay webhook event carries a subscription entity (e.g.
    // plain one-off payment events also reach this same endpoint if
    // configured broadly in the dashboard) - nothing for this function to do
    // with those, and it's not an error.
    return json({ received: true, skipped: true });
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: subscriptionRow } = await serviceClient
    .from('subscriptions')
    .select('id, clinic_id, plan_id')
    .eq('razorpay_subscription_id', sub.id)
    .maybeSingle();
  if (!subscriptionRow) {
    // A subscription Razorpay knows about but we don't (a stale test event,
    // or one created outside this app) - acknowledge so Razorpay stops
    // retrying delivery, but there is nothing to update.
    return json({ received: true, skipped: true, reason: 'unknown_subscription' });
  }

  const clinicId = subscriptionRow.clinic_id as string;

  const notify = async (message: string, type: string) => {
    const { data: clinic } = await serviceClient.from('clinics').select('owner_id').eq('id', clinicId).maybeSingle();
    if (!clinic?.owner_id) return;
    await serviceClient.from('notifications').insert({ user_id: clinic.owner_id, type, message, channel: 'in_app' });
  };

  if (event.event === 'subscription.charged') {
    const payment = event.payload.payment?.entity;
    const periodStart = toIso(sub.current_start) ?? new Date().toISOString();
    const periodEnd = toIso(sub.current_end) ?? new Date().toISOString();

    let planPrice: number | null = null;
    if (!payment) {
      const { data: plan } = await serviceClient
        .from('plans')
        .select('monthly_price')
        .eq('id', subscriptionRow.plan_id)
        .maybeSingle();
      planPrice = plan?.monthly_price ?? null;
    }

    await serviceClient.from('invoices').insert({
      clinic_id: clinicId,
      period_start: periodStart,
      period_end: periodEnd,
      amount: payment ? payment.amount / 100 : (planPrice ?? 0),
      status: 'paid',
      razorpay_payment_id: payment?.id ?? null,
    });
    await serviceClient
      .from('subscriptions')
      .update({ current_period_end: periodEnd, billing_status: 'active', past_due_since: null })
      .eq('id', subscriptionRow.id);
    await serviceClient.from('clinics').update({ is_active: true }).eq('id', clinicId).eq('is_active', false);
    await notify(
      `Your subscription payment succeeded. Your clinic stays live through ${new Date(periodEnd).toLocaleDateString()}.`,
      'billing_paid'
    );
  } else if (event.event === 'subscription.pending') {
    const payment = event.payload.payment?.entity;
    const periodStart = toIso(sub.current_start) ?? new Date().toISOString();
    const periodEnd = toIso(sub.current_end) ?? new Date().toISOString();

    await serviceClient.from('invoices').insert({
      clinic_id: clinicId,
      period_start: periodStart,
      period_end: periodEnd,
      amount: payment ? payment.amount / 100 : 0,
      status: 'failed',
      razorpay_payment_id: payment?.id ?? null,
    });
    await serviceClient.from('subscriptions').update({ billing_status: 'past_due' }).eq('id', subscriptionRow.id);
    // Only stamp past_due_since the first time - a later retry failing again
    // in the same cycle shouldn't push the "how long has this been failing"
    // clock forward.
    await serviceClient
      .from('subscriptions')
      .update({ past_due_since: new Date().toISOString() })
      .eq('id', subscriptionRow.id)
      .is('past_due_since', null);
    await notify(
      "Your subscription renewal payment failed. We'll retry automatically - please make sure your payment method is up to date to avoid losing visibility in patient search.",
      'billing_past_due'
    );
  } else if (event.event === 'subscription.halted') {
    await serviceClient.from('subscriptions').update({ billing_status: 'past_due' }).eq('id', subscriptionRow.id);
    await serviceClient.from('clinics').update({ is_active: false }).eq('id', clinicId);
    await notify(
      "Your subscription payments have failed repeatedly. Your clinic is now hidden from patient search and can't accept new bookings until you resubscribe or update your payment method.",
      'billing_halted'
    );
  }
  // Any other event: acknowledged, no action - see this function's header.

  return json({ received: true });
});
