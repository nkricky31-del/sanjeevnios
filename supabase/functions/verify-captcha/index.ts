// supabase/functions/verify-captcha/index.ts
//
// Verifies a Cloudflare Turnstile token SERVER-SIDE (the secret key never
// reaches the browser) and, if it is valid, records a short-lived "pass" for
// the signed-in user. The appointments insert trigger (migration 75) refuses a
// booking from a patient without a pass.
//
// Deploy:  npx supabase functions deploy verify-captcha
// Secret:  npx supabase secrets set TURNSTILE_SECRET_KEY=0x...
import { createClient } from 'npm:@supabase/supabase-js@2';

import { authenticate } from '../_shared/authorize.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TURNSTILE_SECRET_KEY = Deno.env.get('TURNSTILE_SECRET_KEY');
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const auth = await authenticate(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  if (!TURNSTILE_SECRET_KEY) return json({ error: 'Bot check is not configured.' }, 500);

  let token = '';
  try {
    const body = await req.json();
    token = typeof body?.token === 'string' ? body.token : '';
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  if (!token || token.length > 2048) return json({ error: 'Missing bot-check token.' }, 400);

  const form = new FormData();
  form.append('secret', TURNSTILE_SECRET_KEY);
  form.append('response', token);
  const ip = req.headers.get('cf-connecting-ip');
  if (ip) form.append('remoteip', ip);

  const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const result = await verify.json().catch(() => ({ success: false }));
  if (!result.success) return json({ error: 'Bot check failed. Please try again.' }, 403);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc('record_captcha_pass', { p_user_id: auth.caller.user.id });
  if (error) {
    console.error('record_captcha_pass failed:', error.message);
    return json({ error: 'Could not record the bot check.' }, 500);
  }
  return json({ ok: true, expiresAt: data });
});
