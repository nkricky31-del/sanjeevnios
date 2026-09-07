// supabase/functions/release-clinic-payout/index.ts
//
// The ONLY place real money might actually move for a payout. Everything
// about WHETHER and WHEN a payment is released lives entirely in the
// database (release_settlement()/release_eligible_settlements(), migration
// 59) - this function is called AFTER that DB decision already happened,
// and only attempts the matching Razorpay ROUTE transfer for each row that
// is (by the time this runs) already 'released'. If it fails, times out, or
// isn't even configured, the release itself already stands - the settlement
// stays 'released' (not 'settled') and supabase/functions/razorpay-webhook's
// transfer.processed handler (or an admin's manual "Mark settled") is what
// finishes the job later. This function never decides to release anything
// itself, and never holds funds anywhere it runs - see migration 59's own
// header on why that matters ("not a wallet").
//
// Route requires a linked/sub-merchant account per clinic - provisioned on
// Razorpay's own dashboard (or their Account API, out of scope here), its id
// stored on clinics.razorpay_fund_account_id. A clinic with nothing there
// yet is reported back as skipped, never an error - pay it out through
// whatever process you're already using, then either wait for Route to be
// configured or call mark_settlement_settled() by hand once you have.
//
// Deploy: npx supabase functions deploy release-clinic-payout
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

interface SettlementRow {
  id: string;
  clinic_id: string;
  net_payout: number | null;
  status: string;
  razorpay_transfer_id: string | null;
  payments: { razorpay_payment_id: string | null } | null;
  clinics: { razorpay_fund_account_id: string | null } | null;
}

interface TransferResult {
  settlementId: string;
  sent: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  transferId?: string;
}

async function attemptTransfer(serviceClient: ReturnType<typeof createClient>, row: SettlementRow): Promise<TransferResult> {
  if (row.status !== 'released') {
    return { settlementId: row.id, sent: false, skipped: true, reason: 'not_released' };
  }
  if (row.razorpay_transfer_id) {
    return { settlementId: row.id, sent: false, skipped: true, reason: 'already_attempted' };
  }
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return { settlementId: row.id, sent: false, skipped: true, reason: 'razorpay_not_configured' };
  }
  const fundAccountId = row.clinics?.razorpay_fund_account_id;
  if (!fundAccountId) {
    return { settlementId: row.id, sent: false, skipped: true, reason: 'no_linked_account' };
  }
  const razorpayPaymentId = row.payments?.razorpay_payment_id;
  if (!razorpayPaymentId) {
    return { settlementId: row.id, sent: false, skipped: true, reason: 'no_razorpay_payment_id' };
  }
  if (row.net_payout == null || row.net_payout <= 0) {
    return { settlementId: row.id, sent: false, skipped: true, reason: 'nothing_owed' };
  }

  try {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${razorpayPaymentId}/transfers`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transfers: [
          {
            account: fundAccountId,
            amount: Math.round(row.net_payout * 100),
            currency: 'INR',
            notes: { settlement_id: row.id, clinic_id: row.clinic_id },
          },
        ],
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return { settlementId: row.id, sent: false, error: `Razorpay transfer failed: ${detail}` };
    }
    const body = (await res.json()) as { items?: { id: string }[] };
    const transferId = body.items?.[0]?.id;
    if (transferId) {
      await serviceClient.from('settlements').update({ razorpay_transfer_id: transferId }).eq('id', row.id);
    }
    return { settlementId: row.id, sent: true, transferId };
  } catch (err) {
    return { settlementId: row.id, sent: false, error: String(err) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header.' }, 401);

  let body: { settlementIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const settlementIds = body.settlementIds;
  if (!Array.isArray(settlementIds) || settlementIds.length === 0) {
    return json({ error: 'settlementIds (a non-empty array) is required.' }, 400);
  }

  // Admin-only - same is_admin() RPC every other admin-only edge function
  // already checks (see send-clinic-approval-notice for the identical shape).
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: isAdmin } = await callerClient.rpc('is_admin');
  if (!isAdmin) return json({ error: 'Only an admin can release a payout.' }, 403);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: rows, error: rowsError } = await serviceClient
    .from('settlements')
    .select('id, clinic_id, net_payout, status, razorpay_transfer_id, payments(razorpay_payment_id), clinics(razorpay_fund_account_id)')
    .in('id', settlementIds);
  if (rowsError) return json({ error: rowsError.message }, 500);

  const results = await Promise.all(((rows ?? []) as unknown as SettlementRow[]).map((row) => attemptTransfer(serviceClient, row)));

  return json({ results });
});
