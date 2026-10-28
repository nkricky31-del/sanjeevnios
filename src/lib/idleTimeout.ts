import { supabase } from './supabaseClient';

// Sign-out after inactivity. If nobody touches the app (tap, click, type,
// scroll) for this long - including while it's closed - the next time it's
// opened, or as soon as the limit passes while it's open, the person is signed
// out and asked to log in again. Change the numbers here.
export type IdleRole = 'admin' | 'clinic' | 'patient';

export const IDLE_LIMIT_MINUTES: Record<IdleRole, number> = {
  admin: 15, // sees everything - shortest
  clinic: 30, // shared desk computers with patient data
  patient: 60, // their own phone
};

export const LOGIN_PATH: Record<IdleRole, string> = {
  admin: '/admin/login',
  clinic: '/clinic/login',
  patient: '/login',
};

// localStorage, so every open tab on this device shares one clock: using the
// app in one tab keeps the others signed in.
const ACTIVITY_KEY = 'sn_last_activity';
// Why the person is looking at a login screen - read once by the login page
// for its notice, then cleared. Only honoured for a short while after.
const SIGNED_OUT_KEY = 'sn_idle_signed_out';
const SIGNED_OUT_VALID_MS = 15 * 60_000;

export function idleRoleFor(role: string | null | undefined, actingMode: 'patient' | 'clinic' | null): IdleRole {
  if (role === 'admin') return 'admin';
  const mode = actingMode ?? (role === 'clinic' ? 'clinic' : 'patient');
  return mode === 'clinic' ? 'clinic' : 'patient';
}

export function markActive(at = Date.now()): void {
  try {
    localStorage.setItem(ACTIVITY_KEY, String(at));
  } catch {
    // storage unavailable (private mode) - the open-tab timer still works
  }
}

export function lastActiveAt(): number | null {
  try {
    const v = Number(localStorage.getItem(ACTIVITY_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

// Milliseconds left before this role is signed out (<= 0: already over).
// With no record yet (e.g. a session from before this existed) the clock
// starts now rather than signing anyone out by surprise.
export function msUntilIdle(role: IdleRole, now = Date.now()): number {
  const last = lastActiveAt() ?? now;
  return last + IDLE_LIMIT_MINUTES[role] * 60_000 - now;
}

export function isIdleExpired(role: IdleRole, now = Date.now()): boolean {
  return lastActiveAt() != null && msUntilIdle(role, now) <= 0;
}

export function readIdleSignOut(): IdleRole | null {
  try {
    const raw = localStorage.getItem(SIGNED_OUT_KEY);
    if (!raw) return null;
    const { role, at } = JSON.parse(raw) as { role: IdleRole; at: number };
    if (!(role in IDLE_LIMIT_MINUTES) || Date.now() - at > SIGNED_OUT_VALID_MS) return null;
    return role;
  } catch {
    return null;
  }
}

export function clearIdleSignOut(): void {
  try {
    localStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    // ignore
  }
}

// Signs out THIS device only. Supabase's default sign-out ends every session
// of the account, which would also log out the clinic's other desks.
export async function signOutForInactivity(role: IdleRole): Promise<void> {
  try {
    localStorage.setItem(SIGNED_OUT_KEY, JSON.stringify({ role, at: Date.now() }));
  } catch {
    // ignore
  }
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
}

// Called by the login screens once the code is verified: a fresh login starts
// a fresh clock (otherwise an old timestamp would sign them straight out).
export function startActiveSession(): void {
  markActive();
  clearIdleSignOut();
}
