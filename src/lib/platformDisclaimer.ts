// Bump this whenever the declaration text below changes materially - a
// patient who accepted an older version is asked to accept again (see
// usePatientDeclarationStatus below). Separate from AGREEMENT_VERSION in
// consent.ts, which is the doctor's onboarding agreement - a different
// legal document entirely.
export const PATIENT_DECLARATION_VERSION = '2026-08-31-v1';

// Sample text - a lawyer must review before launch.
export const PATIENT_DECLARATION_TEXT =
  'I understand that Sanjeevni is an appointment-booking and technology platform that connects me with independent clinics and doctors. Sanjeevni does not provide medical advice, diagnosis or treatment, and is not responsible for the care given by any clinic or doctor. For an emergency I will call my local emergency number.';

// Short, permanent line for the app footer and the booking screen.
export const PLATFORM_DISCLAIMER_SHORT =
  'SanjeevniOS is a booking platform, not a healthcare provider - clinics and doctors listed here provide care independently.';

export const EMERGENCY_NOTE =
  'In an emergency, call your local emergency number - do not wait for an online booking.';
