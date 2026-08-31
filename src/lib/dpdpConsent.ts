// Bump this whenever the consent text below changes materially - a patient
// who accepted an older version is asked to accept again (see
// usePatientConsent.ts). Separate from PATIENT_DECLARATION_VERSION in
// platformDisclaimer.ts - this is a different legal consent entirely (DPDP
// data handling vs. "we're a booking platform, not a care provider"), kept
// deliberately as its own checkbox rather than merged text.
export const DPDP_CONSENT_VERSION = '2026-09-01-v1';

// Sample text - a lawyer must review before launch.
export const DPDP_CONSENT_TEXT =
  'I consent to Sanjeevni collecting, storing, and sharing my (and any family member I add) personal and health information - including visit history, diagnoses, prescriptions, and uploaded reports - with the clinics and doctors I choose to book with, for the purpose of providing care through this platform, in accordance with the Digital Personal Data Protection Act, 2023. I understand I can contact Sanjeevni support to request access to or deletion of my data.';
