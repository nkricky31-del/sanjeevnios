// Which app shell a signed-in session currently sees: 'patient' or 'clinic'.
// This is the "one phone, two roles, kept separate" mechanism - a clinic
// owner (or a staff phone added under clinic_staff_phones - see
// supabase/migration_57_clinic_login_id.sql) is ALSO a patient under the
// exact same account, since Supabase phone auth only ever gives one auth
// user per phone number. There is no second profiles row to keep them in:
// the separation instead happens at the SESSION level, right here, and
// App.tsx reuses the existing Part 50 route guard to enforce it - a
// 'patient' session never renders a clinic route and vice versa, exactly
// like a signed-out visitor never reaches a private one.
//
// sessionStorage, not localStorage, so each browser tab/session picks its
// own mode independently and nothing leaks into a later, unrelated sign-in
// on the same device - same reasoning as CLINIC_SIGNUP_INTENT_KEY
// (clinicSignupIntent.ts). PatientLogin.tsx / ClinicLogin.tsx each set this
// the moment their own form is submitted (BEFORE the OTP round trip, so
// it's already in place no matter how AuthContext's onAuthStateChange and
// this call happen to interleave) - so "choosing Patient" vs "choosing
// Clinic" at login is what actually decides which app a dual-role account
// lands in, not a stored database role. App.tsx falls back to profiles.role
// only when NO explicit choice exists yet in this session (a fresh tab
// picking up an already-persisted Supabase session) - see its own comment.
export type ActingMode = 'patient' | 'clinic';

const ACTING_MODE_KEY = 'sn_acting_mode';

export function setActingMode(mode: ActingMode): void {
  sessionStorage.setItem(ACTING_MODE_KEY, mode);
}

export function getStoredActingMode(): ActingMode | null {
  const value = sessionStorage.getItem(ACTING_MODE_KEY);
  return value === 'patient' || value === 'clinic' ? value : null;
}

export function clearActingMode(): void {
  sessionStorage.removeItem(ACTING_MODE_KEY);
}
