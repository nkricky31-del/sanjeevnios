// supabase/functions/sync-razorpay-subscription-plan/index.ts
//
// migration_62_doctor_count_plans.sql's reassign_clinic_plan_for_doctor_count()
// trigger already changed subscriptions.plan_id the instant a clinic needed
// upgrading (a doctor just went live and pushed it past its tier) - that's
// the real decision, already made and already reflected everywhere this app
// itself reads plan_id (ClinicBilling.tsx, invoices). This function is only
// the best-effort OUTSIDE half: telling Razorpay's own subscription to
// switch to the new plan too, so what Razorpay actually charges next cycle
// matches. If this fails, times out, or Razorpay isn't configured at all,
// the plan change already stands regardless - admin can always update the
// Razorpay-side subscription by hand from their dashboard in the meantime.
//
// schedule_change_at: 'cycle_end' is what makes this "add it next cycle,
// not pro-rated now" (migration 62's own header) actually true on
// Razorpay's side, not just in our own database.
//
// Deploy: npx supabase functions deploy sync-razorpay-subscription-plan
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  // 1. WHO - a real, unexpired user session (see _shared/authorize.ts).
  const auth = await authenticate(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const { caller } = auth;

  let body: { clinicId?: string } = {};
  try {
    body = await req.json();
  } catch {
    // An empty body is fine for a clinic caller - its clinic comes from its
    // own membership below.
  }

  // 2 + 3. WHICH CLINIC / ALLOWED - a clinic user always syncs its OWN
  // clinic (any clinicId it sent is ignored); only an admin may name one.
  const clinicId = resolveClinicId(caller, body.clinicId);
  if (!clinicId) {
    return json({ error: caller.isAdmin ? 'clinicId is required.' : 'This account has no clinic.' }, caller.isAdmin ? 400 : 403);
  }

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return json({ synced: false, skipped: true, reason: 'razorpay_not_configured' });
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: sub, error: subError } = await serviceClient
    .from('subscriptions')
    .select('razorpay_subscription_id, plans(razorpay_plan_id, name)')
    .eq('clinic_id', clinicId)
    .maybeSingle();
  if (subError || !sub) return json({ synced: false, skipped: true, reason: 'no_subscription' });

  const razorpaySubscriptionId = sub.razorpay_subscription_id as string | null;
  const plan = sub.plans as unknown as { razorpay_plan_id: string | null; name: string } | null;

  if (!razorpaySubscriptionId) {
    // This clinic has never actually checked out through Razorpay (e.g.
    // still mid-onboarding, or an admin assigned a plan directly) - nothing
    // on Razorpay's side to update yet.
    return json({ synced: false, skipped: true, reason: 'not_on_razorpay_yet' });
  }
  if (!plan?.razorpay_plan_id) {
    // The TARGET plan has never been checked out through Razorpay by ANY
    // clinic yet, so it has no Razorpay-side Plan to switch to -
    // razorpay-create-subscription only ever creates one lazily, on a
    // fresh subscribe. Until that's happened once, this is a documented
    // manual step: update this subscription from the Razorpay dashboard.
    return json({ synced: false, skipped: true, reason: 'target_plan_not_linked_to_razorpay' });
  }

  try {
    const res = await fetch(`https://api.razorpay.com/v1/subscriptions/${razorpaySubscriptionId}`, {
      method: 'PATCH',
      headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: plan.razorpay_plan_id, schedule_change_at: 'cycle_end' }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return json({ synced: false, error: `Razorpay subscription update failed: ${detail}` }, 502);
    }
    // 6. Audit.
    await audit(serviceClient, caller, 'subscription_plan_synced', clinicId);
    return json({ synced: true, appliesFrom: 'cycle_end' });
  } catch (err) {
    return json({ synced: false, error: String(err) }, 502);
  }
});
