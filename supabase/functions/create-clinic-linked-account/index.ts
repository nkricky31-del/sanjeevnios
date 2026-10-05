// supabase/functions/create-clinic-linked-account/index.ts
//
// Provisions the Razorpay Route linked account release-clinic-payout has
// always assumed would already exist on clinics.razorpay_fund_account_id
// (migration 59's own comment: "provisioned on Razorpay's own dashboard...
// out of scope here"). This is that scope: given the clinic's KYC + bank
// details (collected once, by an admin, in AdminPayoutAccounts.tsx - never
// stored in our own database, only forwarded to Razorpay), it
//   1. POSTs https://api.razorpay.com/v2/accounts to create the linked
//      account (skipped if the clinic already has one - see p_account_id
//      reuse below, so a failed/retried second call doesn't create a
//      duplicate account for the same clinic),
//   2. POSTs .../v2/accounts/{id}/products to request the 'route' product
//      with the clinic's settlement bank details and tnc_accepted,
//   3. records the resulting account id + the PRODUCT's activation_status
//      (requested/under_review/needs_clarification/activated) via
//      admin_set_clinic_payout_account() (migration 64) - called with the
//      caller's OWN session, not a service-role client, so that RPC's own
//      is_admin() check is the real thing, not a null-auth.uid() false
//      negative (see migration 64's header on exactly why).
// A clinic only ever appears in release-clinic-payout's transfers once this
// status reaches 'activated' - 'requested'/'under_review' just means
// Razorpay hasn't finished reviewing it yet, same as any new payout account
// anywhere.
//
// Deploy: npx supabase functions deploy create-clinic-linked-account
// Secrets: shares RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET with the other razorpay-* functions.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
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

interface RequestBody {
  clinicId?: string;
  email?: string;
  phone?: string;
  legalBusinessName?: string;
  businessType?: string;
  contactName?: string;
  pan?: string;
  address?: { street1?: string; street2?: string; city?: string; state?: string; postalCode?: string };
  bank?: { accountNumber?: string; ifscCode?: string; beneficiaryName?: string };
}

const BUSINESS_TYPES = [
  'llp', 'ngo', 'other', 'individual', 'partnership', 'proprietorship',
  'public_limited', 'private_limited', 'trust', 'society', 'not_yet_registered', 'educational_institutes',
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header.' }, 401);
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return json({ error: 'Razorpay is not configured on this server.' }, 503);
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const { clinicId, email, phone, legalBusinessName, businessType, contactName, pan, address, bank } = body;
  if (!clinicId || !email || !phone || !legalBusinessName || !businessType || !bank?.accountNumber || !bank?.ifscCode || !bank?.beneficiaryName) {
    return json({ error: 'clinicId, email, phone, legalBusinessName, businessType and bank{accountNumber, ifscCode, beneficiaryName} are required.' }, 400);
  }
  if (!BUSINESS_TYPES.includes(businessType)) {
    return json({ error: `businessType must be one of: ${BUSINESS_TYPES.join(', ')}` }, 400);
  }

  // The caller's OWN session throughout - is_admin() (both here and inside
  // admin_set_clinic_payout_account()) needs a real auth.uid(), same
  // "never a service-role client for the actual authorization check" shape
  // release-clinic-payout already uses.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: isAdmin } = await callerClient.rpc('is_admin');
  if (!isAdmin) return json({ error: 'Only an admin can set up a clinic payout account.' }, 403);

  const { data: clinic, error: clinicError } = await callerClient
    .from('clinics')
    .select('id, razorpay_fund_account_id')
    .eq('id', clinicId)
    .maybeSingle();
  if (clinicError) return json({ error: clinicError.message }, 500);
  if (!clinic) return json({ error: 'Clinic not found.' }, 404);

  let accountId = clinic.razorpay_fund_account_id as string | null;

  // Step 1: create the linked account itself, unless a retry after the
  // account already exists but the product/settlement step below failed.
  if (!accountId) {
    const accountRes = await fetch('https://api.razorpay.com/v2/accounts', {
      method: 'POST',
      headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        phone,
        type: 'route',
        reference_id: clinicId,
        legal_business_name: legalBusinessName,
        business_type: businessType,
        contact_name: contactName || undefined,
        profile: {
          category: 'healthcare',
          subcategory: 'clinic',
          addresses: address
            ? {
                registered: {
                  street1: address.street1,
                  street2: address.street2,
                  city: address.city,
                  state: address.state,
                  postal_code: address.postalCode,
                  country: 'IN',
                },
              }
            : undefined,
        },
        legal_info: pan ? { pan } : undefined,
      }),
    });
    const accountBody = await accountRes.json();
    if (!accountRes.ok) {
      return json({ error: `Razorpay account creation failed: ${accountBody?.error?.description ?? JSON.stringify(accountBody)}` }, 502);
    }
    accountId = accountBody.id as string;
  }

  // Step 2: request the 'route' product with the clinic's settlement bank
  // details - this, not the account's own top-level status, is what
  // actually determines whether a transfer can succeed later.
  const productRes = await fetch(`https://api.razorpay.com/v2/accounts/${accountId}/products`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_name: 'route',
      tnc_accepted: true,
      settlements: {
        account_number: bank.accountNumber,
        ifsc_code: bank.ifscCode,
        beneficiary_name: bank.beneficiaryName,
      },
    }),
  });
  const productBody = await productRes.json();
  if (!productRes.ok) {
    // The linked account was still created (accountId is real) even though
    // this step failed - record that much so a retry (backed by the
    // `if (!accountId)` skip above) only re-attempts the product step.
    await callerClient.rpc('admin_set_clinic_payout_account', {
      p_clinic_id: clinicId,
      p_account_id: accountId,
      p_status: 'not_started',
      p_note: `Route product setup failed: ${productBody?.error?.description ?? JSON.stringify(productBody)}`,
    });
    return json({ error: `Razorpay Route product setup failed: ${productBody?.error?.description ?? JSON.stringify(productBody)}`, accountId }, 502);
  }

  const activationStatus = (productBody.activation_status as string) ?? 'requested';
  const requirementNote = Array.isArray(productBody.requirements) && productBody.requirements.length > 0
    ? productBody.requirements.map((r: { field_reference?: string; reason_code?: string }) => r.field_reference || r.reason_code).filter(Boolean).join(', ')
    : null;
  // The product CONFIGURATION's own id (not the account id) - no webhook is
  // configured to push status changes (migration 65's own header), so
  // check-clinic-payout-account-status needs this to re-fetch later.
  const productId = productBody.id as string | undefined;

  const { data: updated, error: rpcError } = await callerClient.rpc('admin_set_clinic_payout_account', {
    p_clinic_id: clinicId,
    p_account_id: accountId,
    p_status: activationStatus,
    p_note: requirementNote,
    p_product_id: productId,
  });
  if (rpcError) return json({ error: rpcError.message }, 500);

  return json({ accountId, status: activationStatus, note: requirementNote, clinic: updated });
});
