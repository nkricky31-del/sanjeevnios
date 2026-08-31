// Bump this whenever the agreement text below changes materially - a
// doctor who signed an older version shows up as needing to re-sign.
export const AGREEMENT_VERSION = '2026-08-31-v1';

export const AGREEMENT_TEXT = `Agreement to join SanjeevniOS

1. Terms of listing
By signing this agreement, you consent to being listed as a doctor on the SanjeevniOS platform once your clinic and your own registration are approved by an admin. Your listing (name, specialty, consultation fee, and availability) will be visible to patients searching the platform.

2. Fees
SanjeevniOS deducts a platform fee from each online payment collected through the app before paying out the remainder to your clinic. Cash-on-visit payments are collected by your clinic directly and are not subject to this fee.

3. Code of conduct
You agree to treat patients professionally, keep your listed availability accurate, and respond to bookings in a timely manner. Repeated no-shows, unexplained rejections, or patient complaints may result in review or suspension of your listing.

4. Data handling
Patient information you access through the platform (contact details, visit history, uploaded files) may only be used for the purpose of providing care through SanjeevniOS, and must be handled in accordance with applicable data protection law. Documents you upload for verification are stored privately and are only visible to your clinic and to SanjeevniOS admins.`;

// Best-effort client IP for the consent record - a public IP-echo lookup,
// not an authenticated server-side capture. Good enough for a consent
// audit trail; if it fails for any reason (offline, blocked, etc.) the
// consent is still recorded, just without an IP.
export async function getClientIp(): Promise<string | null> {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.ip === 'string' ? data.ip : null;
  } catch {
    return null;
  }
}
