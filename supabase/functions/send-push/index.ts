// send-push: sends patients' alerts to their phones through Firebase Cloud
// Messaging (design: docs/superpowers/specs/2026-10-30-push-notifications-design.md).
//
// The database calls this, never the app: whenever patient alerts are
// written to the notification list, a trigger posts their ids here
// (migration 93). So it is deployed without a login check
// (scripts/deploy-functions.sh), and it accepts nothing but those ids - no
// text, no recipient. It claims them in the database (only patient alerts
// from the last 10 minutes that haven't been sent, each exactly once) and
// reads the wording and the patient's phones from there itself, so a stray
// call can at most deliver real alerts to their own patients.
//
// Needs the FIREBASE_SERVICE_ACCOUNT secret (scripts/set-firebase-key.sh).
// Until it is set, nothing is claimed or sent: alerts stay in the app.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { FcmClient, parseServiceAccount } from '../_shared/fcm.ts';
import { type ClaimedRow, readIds, runPush } from './push.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MAX_BODY = 64 * 1024;

const account = parseServiceAccount(Deno.env.get('FIREBASE_SERVICE_ACCOUNT'));
const fcm = account ? new FcmClient(account) : null;
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY) return json({ error: 'Too large.' }, 413);

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: 'Too large.' }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Send JSON.' }, 400);
  }
  const ids = readIds(body);
  if (!ids) return json({ error: 'Send {"ids": [...]} with 1 to 500 notification ids.' }, 400);

  if (!fcm) return json({ sent: 0, skipped: 'FIREBASE_SERVICE_ACCOUNT is not set' });

  try {
    const result = await runPush(ids, {
      claim: async (batch) => {
        const { data, error } = await db.rpc('claim_push_batch', { p_ids: batch });
        if (error) throw new Error(error.message);
        return (data ?? []) as ClaimedRow[];
      },
      forget: async (tokens) => {
        const { error } = await db.rpc('forget_push_tokens', { p_tokens: tokens });
        if (error) console.warn('forget_push_tokens failed:', error.message);
      },
      send: (message) => fcm.send(message),
      warn: (text) => console.warn(text),
    });
    return json({ ...result });
  } catch (err) {
    console.error('send-push failed:', err);
    return json({ error: 'Could not send.' }, 500);
  }
});
