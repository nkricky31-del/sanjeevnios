// supabase/functions/_shared/authorize.ts
//
// The server-side authorization every sensitive edge function runs, in this
// order (migration 67 does the same for the database itself):
//
//   1. WHO - a valid, unexpired user session, or 401. Checking that an
//      Authorization header merely EXISTS isn't enough: supabase-js sends the
//      public anon key in that header when nobody is signed in, so every
//      function here used to treat "signed out" as "signed in, not allowed"
//      (403). authenticate() asks Supabase Auth to resolve the token to a
//      real user instead.
//   2. WHICH CLINIC - taken from the caller's own membership (my_clinic_id():
//      clinics.owner_id or clinic_staff_phones), never from a clinic id the
//      browser sends. An admin is the one caller allowed to act on a clinic
//      by id.
//   3. ALLOWED - each function checks caller.isAdmin / caller.clinicId for
//      the action it performs, and returns 403 if the role doesn't fit.
//   4. THIS RESOURCE - load the target with the CALLER's client (row-level
//      security applies), so another clinic's or patient's id comes back as
//      "not found" (404), never as their data.
//   5. RULES - each function's own business checks.
//   6. Do the work, then audit() it.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

export interface Caller {
  user: User;
  // Acts AS the caller - every query through it is subject to row-level
  // security, so use it to load anything the caller names by id.
  client: SupabaseClient;
  isAdmin: boolean;
  // The clinic this user owns or staffs, from the database - null if none.
  clinicId: string | null;
}

export type AuthResult = { ok: true; caller: Caller } | { ok: false; status: 401; error: string };

export async function authenticate(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'Sign in to continue.' };

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // getUser() validates the token with Supabase Auth (signature AND expiry)
  // and fails for the anon key, which isn't a user.
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    return { ok: false, status: 401, error: 'Your session has expired. Sign in again.' };
  }

  const [{ data: isAdmin }, { data: clinicId }] = await Promise.all([
    client.rpc('is_admin'),
    client.rpc('my_clinic_id'),
  ]);

  return {
    ok: true,
    caller: { user: data.user, client, isAdmin: isAdmin === true, clinicId: (clinicId as string | null) ?? null },
  };
}

// The clinic a request acts on. A clinic user always gets their OWN clinic -
// whatever clinicId they sent is ignored. Only an admin may name one.
export function resolveClinicId(caller: Caller, requestedClinicId: string | undefined | null): string | null {
  if (caller.isAdmin) return requestedClinicId ?? caller.clinicId;
  return caller.clinicId;
}

// Audit trail for a server-side action. The actor is the user Supabase Auth
// just verified - never a value from the request body.
export async function audit(db: SupabaseClient, caller: Caller, action: string, target: string): Promise<void> {
  const { error } = await db.from('audit_log').insert({ actor: caller.user.id, action, target });
  if (error) console.error(`audit_log insert failed for ${action}:`, error.message);
}
