// supabase/functions/razorpay-create-subscription/index.ts
//
// Creates (once, lazily) the Razorpay Plan matching one of our plans rows,
// then a Razorpay Subscription against it, and returns just enough for the
// client to open Checkout in subscription mode. Nothing here changes any
// billing state (plan_id, billing_status, is_active) - only razorpay-webhook
// does that, once Razorpay actually confirms a charge. This function only
// ever RECORDS which Razorpay subscription id belongs to which clinic, so
// the webhook has something to look the clinic up by later.
//
// Deploy: npx supabase functions deploy razorpay-create-subscription
// Secrets: shares RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET with the other razorpay-* functions.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { audit, authenticate, resolveClinicId } from '../_shared/authorize.ts';

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

async function razorpayFetch(path: string, body: Record<string, unknown>) {
  return fetch(`https://api.razorpay.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  // 1. WHO - a real, unexpired user session (see _shared/authorize.ts).
  const auth = await authenticate(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const { caller } = auth;

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return json({ error: 'Billing is not configured on this server yet.' }, 503);
  }

  let body: { clinicId?: string; planId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const { planId } = body;
  if (!planId) return json({ error: 'planId is required.' }, 400);

  // 2 + 3. WHICH CLINIC / ALLOWED - a clinic user always subscribes its OWN
  // clinic (any clinicId it sent is ignored); only an admin may name one.
  const clinicId = resolveClinicId(caller, body.clinicId);
  if (!clinicId) {
    return json({ error: caller.isAdmin ? 'clinicId is required.' : 'This account has no clinic.' }, caller.isAdmin ? 400 : 403);
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: plan, error: planError } = await serviceClient
    .from('plans')
    .select('id, name, monthly_price, razorpay_plan_id, active')
    .eq('id', planId)
    .maybeSingle();
  if (planError || !plan) return json({ error: 'Plan not found.' }, 404);
  if (!plan.active) return json({ error: 'This plan is no longer available.' }, 400);

  // 5. RULES - a clinic can't pick a plan smaller than its verified, active
  // doctor count needs (migration 62); otherwise choosing Solo with six
  // doctors would quietly undercut the price. An admin may override.
  if (!caller.isAdmin) {
    const { data: requiredPlanId } = await serviceClient.rpc('plan_for_doctor_count_for_clinic', { p_clinic_id: clinicId });
    if (requiredPlanId && requiredPlanId !== plan.id) {
      const { data: required } = await serviceClient
        .from('plans')
        .select('name, monthly_price')
        .eq('id', requiredPlanId)
        .maybeSingle();
      if (required && Number(plan.monthly_price) < Number(required.monthly_price)) {
        return json(
          { error: `Your verified doctors need at least the ${required.name} plan (₹${required.monthly_price}/month).` },
          409
        );
      }
    }
  }

  // Razorpay's Plans API rejects a zero-amount item outright, and there is
  // nothing to charge for a free plan anyway - assign it directly instead
  // of ever touching Razorpay. subscriptions_write is admin-only, so this
  // (already-authorized-above, service-role) assignment is the only way a
  // clinic can move itself onto a free plan without an admin doing it by
  // hand. Note: this does NOT cancel any existing paid Razorpay subscription
  // the clinic already had - that's a real gap (a clinic downgrading to
  // free while still being charged for its old plan) worth closing later
  // with an explicit Razorpay subscription-cancel call, but is out of scope
  // for what was asked here.
  if (plan.monthly_price <= 0) {
    const { error: upsertError } = await serviceClient
      .from('subscriptions')
      .upsert({ clinic_id: clinicId, plan_id: plan.id }, { onConflict: 'clinic_id' });
    if (upsertError) return json({ error: `Could not assign this plan: ${upsertError.message}` }, 500);
    await audit(serviceClient, caller, 'subscription_plan_assigned', clinicId);
    return json({ assignedDirectly: true });
  }

  let razorpayPlanId = plan.razorpay_plan_id as string | null;
  if (!razorpayPlanId) {
    // Razorpay's own Plan doesn't exist yet for this row - create it once,
    // lazily, the first time anyone subscribes to it.
    const planRes = await razorpayFetch('plans', {
      period: 'monthly',
      interval: 1,
      item: {
        name: plan.name,
        amount: Math.round(plan.monthly_price * 100),
        currency: 'INR',
        description: `Sanjeevnios clinic subscription - ${plan.name}`,
      },
    });
    if (!planRes.ok) {
      const detail = await planRes.text();
      return json({ error: `Razorpay plan creation failed: ${detail}` }, 502);
    }
    const razorpayPlan = (await planRes.json()) as { id: string };
    razorpayPlanId = razorpayPlan.id;
    await serviceClient.from('plans').update({ razorpay_plan_id: razorpayPlanId }).eq('id', plan.id);
  }

  // total_count is required by Razorpay's API even for an effectively
  // open-ended subscription - 120 monthly cycles (10 years) stands in for
  // "until cancelled" without this ever actually needing to be renewed by
  // hand.
  const subRes = await razorpayFetch('subscriptions', {
    plan_id: razorpayPlanId,
    customer_notify: 1,
    total_count: 120,
    notes: { clinic_id: clinicId },
  });
  if (!subRes.ok) {
    const detail = await subRes.text();
    return json({ error: `Razorpay subscription creation failed: ${detail}` }, 502);
  }
  const subscription = (await subRes.json()) as { id: string };

  const { error: upsertError } = await serviceClient
    .from('subscriptions')
    .upsert(
      { clinic_id: clinicId, plan_id: plan.id, razorpay_subscription_id: subscription.id },
      { onConflict: 'clinic_id' }
    );
  if (upsertError) {
    return json({ error: `Subscription created but could not be saved: ${upsertError.message}` }, 500);
  }

  // 6. Audit.
  await audit(serviceClient, caller, 'subscription_created', clinicId);
  return json({ subscriptionId: subscription.id, keyId: RAZORPAY_KEY_ID });
});
