// delete-account: a patient deletes their own SanjeevniOS account (Profile >
// Delete account, in the apps and on the website). Google Play and the App
// Store require this for any app where people can sign up.
//
// What is deleted and what clinics keep is decided in the database
// (migration 91, delete_account): one transaction that refuses clinic and
// staff accounts and anyone with an appointment still to come, detaches the
// visit history clinics must keep, deletes the rest and the login itself.
// This function checks who is asking, runs it for that person only, then
// removes the files in Storage that went with the account.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { authenticate } from '../_shared/authorize.ts';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

// The database's refusals, in words for the person on the screen.
const REFUSALS: Record<string, string> = {
  ACCOUNT_HAS_UPCOMING: 'You have an appointment coming up. Cancel it first, then delete your account.',
  ACCOUNT_CLOSES_BY_REQUEST: 'Clinic and staff accounts are closed on request. Send a request from this screen and we will close it for you.',
  ACCOUNT_NOT_FOUND: 'This account has already been deleted.',
  ACCOUNT_DELETE_BLOCKED: 'We could not delete your account automatically. Nothing was changed - please contact support and we will delete it for you.',
};

Deno.serve(withCors(CORS_HEADERS, async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  // 1. WHO - a real, unexpired session; the account deleted is always the caller's own.
  const auth = await authenticate(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const userId = auth.caller.user.id;

  // 2. MEANT IT - the screen sends this only after the person confirms.
  let body: { confirm?: string } = {};
  try {
    body = await req.json();
  } catch {
    // no body
  }
  if (body.confirm !== 'DELETE') return json({ error: 'Confirm the deletion first.' }, 400);

  // 3. DELETE - one transaction in the database (migration 91).
  const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await service.rpc('delete_account', { p_user: userId });
  if (error) {
    const code = Object.keys(REFUSALS).find((c) => error.message.includes(c));
    if (!code) console.error('delete_account failed:', error.message);
    return json({ error: code ? REFUSALS[code] : REFUSALS.ACCOUNT_DELETE_BLOCKED, code: code ?? 'ACCOUNT_DELETE_FAILED' }, code === 'ACCOUNT_NOT_FOUND' ? 410 : 409);
  }

  // 4. FILES - photos, reports kept outside a visit, ID documents. The
  // account is already gone; a file that fails to delete is logged (the
  // records pointing at it are gone, so nothing can reach it).
  const files = ((data as { storage?: Array<{ bucket: string; path: string }> })?.storage ?? []).filter(
    (f) => f && typeof f.bucket === 'string' && typeof f.path === 'string' && f.path.length > 0,
  );
  const byBucket = new Map<string, string[]>();
  for (const f of files) byBucket.set(f.bucket, [...(byBucket.get(f.bucket) ?? []), f.path]);
  for (const [bucket, paths] of byBucket) {
    for (let i = 0; i < paths.length; i += 100) {
      const { error: removeError } = await service.storage.from(bucket).remove(paths.slice(i, i + 100));
      if (removeError) console.error(`could not remove ${bucket} files for a deleted account:`, removeError.message);
    }
  }

  return json({ deleted: true });
}));
