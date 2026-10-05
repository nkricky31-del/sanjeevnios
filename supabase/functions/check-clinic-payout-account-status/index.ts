// supabase/functions/check-clinic-payout-account-status/index.ts
//
// The pull side of migration 65: with no Razorpay webhook configured for
// product.route.* events, a clinic's razorpay_account_status only ever
// changes when an admin explicitly asks - this is that ask. Re-fetches the
// Route product configuration Razorpay already has on file
// (clinics.razorpay_fund_account_id + razorpay_route_product_id, both set
// by create-clinic-linked-account) and records whatever activation_status
// comes back via admin_set_clinic_payout_account(), same as the webhook
// handler would have.
//
// Deploy: npx supabase functions deploy check-clinic-payout-account-status
// Secrets: shares RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET with the other razorpay-* functions.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { audit, authenticate } from '../_shared/authorize.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
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

  // 1. WHO - a real, unexpired user session (see _shared/authorize.ts).
  const auth = await authenticate(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const { caller } = auth;
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return json({ error: 'Razorpay is not configured on this server.' }, 503);
  }

  let body: { clinicId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  if (!body.clinicId) return json({ error: 'clinicId is required.' }, 400);

  // 3. ALLOWED - admin only. callerClient acts AS the admin, so the RPCs
  // below still run their own is_admin() checks too.
  const callerClient = caller.client;
  if (!caller.isAdmin) return json({ error: 'Only an admin can check a payout account status.' }, 403);

  const { data: clinic, error: clinicError } = await callerClient
    .from('clinics')
    .select('id, razorpay_fund_account_id, razorpay_route_product_id')
    .eq('id', body.clinicId)
    .maybeSingle();
  if (clinicError) return json({ error: clinicError.message }, 500);
  if (!clinic) return json({ error: 'Clinic not found.' }, 404);
  if (!clinic.razorpay_fund_account_id || !clinic.razorpay_route_product_id) {
    return json({ error: 'This clinic has no payout account set up yet.' }, 400);
  }

  const res = await fetch(
    `https://api.razorpay.com/v2/accounts/${clinic.razorpay_fund_account_id}/products/${clinic.razorpay_route_product_id}`,
    { headers: { Authorization: basicAuthHeader() } }
  );
  const productBody = await res.json();
  if (!res.ok) {
    return json({ error: `Razorpay status check failed: ${productBody?.error?.description ?? JSON.stringify(productBody)}` }, 502);
  }

  const activationStatus = (productBody.activation_status as string) ?? 'requested';
  const requirementNote = Array.isArray(productBody.requirements) && productBody.requirements.length > 0
    ? productBody.requirements.map((r: { field_reference?: string; reason_code?: string }) => r.field_reference || r.reason_code).filter(Boolean).join(', ')
    : null;

  const { data: updated, error: rpcError } = await callerClient.rpc('admin_set_clinic_payout_account', {
    p_clinic_id: body.clinicId,
    p_account_id: clinic.razorpay_fund_account_id,
    p_status: activationStatus,
    p_note: requirementNote,
    p_product_id: clinic.razorpay_route_product_id,
  });
  if (rpcError) return json({ error: rpcError.message }, 500);

  // 6. Audit.
  await audit(caller.client, caller, 'payout_account_status_checked', body.clinicId);
  return json({ status: activationStatus, note: requirementNote, clinic: updated });
});
