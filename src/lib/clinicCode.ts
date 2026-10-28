// Clinic IDs are a fixed letters part plus a number: SNJ-CL-000123.
//
// The letters part is shown fixed on the clinic login screen and the clinic
// types only the number. To move to a different letters part later, change
// CLINIC_CODE_PREFIX here and in generate_clinic_code() (migration 57), which
// mints the IDs in the database.
export const CLINIC_CODE_PREFIX = 'SNJ-CL-';

// The number is zero-padded to this many digits (SNJ-CL-000123).
export const CLINIC_CODE_DIGITS = 6;

// What the clinic typed or pasted -> just the number part. A pasted full ID
// ("SNJ-CL-000123", "snjcl000123") works too: the letters part is dropped.
export function clinicNumberInput(raw: string): string {
  const letters = CLINIC_CODE_PREFIX.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const rest = compact.startsWith(letters) ? compact.slice(letters.length) : compact;
  return rest.replace(/\D/g, '').slice(0, 10);
}

// The number part -> the full Clinic ID the server checks: "123" -> "SNJ-CL-000123".
export function clinicCodeFromNumber(number: string): string | null {
  const digits = number.replace(/\D/g, '');
  if (!digits || /^0+$/.test(digits)) return null;
  return CLINIC_CODE_PREFIX + digits.padStart(CLINIC_CODE_DIGITS, '0');
}
