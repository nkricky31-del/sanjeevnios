const COUNTRY_CODE = '91';

// Peels off a leading country code or domestic trunk prefix from an
// already-digits-only string, IF that leaves exactly 10 digits behind.
// Shared by normalizePhone (final validation) and livePhoneDigits (live
// typing/paste) so both agree on what counts as a stray prefix.
function stripKnownPrefix(digits: string): string {
  if (digits.length > 10 && digits.startsWith(COUNTRY_CODE) && digits.length - 2 === 10) {
    return digits.slice(2);
  }
  if (digits.length > 10 && digits.startsWith('0') && digits.length - 1 === 10) {
    return digits.slice(1);
  }
  return digits;
}

// The canonical stored/looked-up form used everywhere in the app
// (family_members.phone, and what Supabase Auth stores in auth.users.phone
// for a phone login) - country code + 10 digits, no '+', no spaces/dashes.
// Returns null if what's left after stripping punctuation and a
// recognised prefix isn't a plausible 10-digit Indian mobile number.
export function normalizePhone(input: string): string | null {
  const digits = stripKnownPrefix(input.replace(/\D/g, ''));
  return digits.length === 10 ? `${COUNTRY_CODE}${digits}` : null;
}

// For supabase.auth.signInWithOtp/verifyOtp, which want the '+' E.164 form.
export function toE164(input: string): string | null {
  const normalized = normalizePhone(input);
  return normalized ? `+${normalized}` : null;
}

// For an onChange handler on a "10 digit local number" input: tolerates
// whatever got pasted in (with a stray +91/91/0 prefix, spaces, dashes)
// without truncating it into garbage the way a bare maxLength + digit-strip
// does - see WalkInForm/FamilyMemberForm/Login's phone inputs, all of which
// used to clip a pasted "+919876543210" into "919876543" (9 digits) because
// the browser's maxLength truncation ran before this handler ever saw it.
export function livePhoneDigits(raw: string): string {
  const digits = stripKnownPrefix(raw.replace(/\D/g, ''));
  return digits.slice(0, 10);
}
