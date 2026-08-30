// Shared between Login.tsx (sets it when someone picks "Register your
// clinic" before signing in) and App.tsx (reads it right after sign-in to
// decide whether a fresh patient account should land on clinic registration
// instead of the normal patient home screen). sessionStorage, not
// localStorage, so it only affects the login that's in progress right now
// and never leaks into a later, unrelated session on the same device.
export const CLINIC_SIGNUP_INTENT_KEY = 'sn_clinic_signup_intent';
