import type { OwnerType } from './types';

export interface DocumentTypeConfig {
  key: string;
  label: string;
  ownerType: OwnerType;
  // Hard-required for a DOCTOR's submit-for-review gate (see
  // enforce_doctor_submission_requirements() in schema.sql - that trigger's
  // required-type list must be kept in sync with the `required: true`
  // entries here). Not meaningful for ownerType 'clinic' - clinic
  // submission isn't gated the same way, see allowNotApplicable instead.
  required: boolean;
  // Required for the owner to reach is_verified (see sync_verification_status()
  // in schema.sql - that function's required-type lists must be kept in sync
  // with the `requiredForVerification: true` entries here). A separate flag
  // from `required` above: e.g. clinic_registration_certificate isn't part of
  // the doctor submission gate at all, but IS required to become verified.
  requiredForVerification?: boolean;
  // True for a checklist item whose `documents` row isn't uploaded by the
  // owner - it's auto-inserted by a DB trigger from some other fact
  // (consents signed, clinics.lat/lng set). DocumentChecklist.tsx (the
  // owner's own upload screen) hides these; AdminDocumentReview.tsx (the
  // admin's review screen) still shows them like any other item.
  autoManaged?: boolean;
  hasNumber?: boolean;
  hasExpiry?: boolean;
  allowNotApplicable?: boolean;
  description: string;
}

// The onboarding checklist screens (DocumentChecklist.tsx and the admin
// review view) render entirely from this list - adding a new document type
// later is just adding an entry here, no screen changes needed. If a new
// entry is `required: true` for ownerType 'doctor', also add its key to the
// array in enforce_doctor_submission_requirements() in schema.sql; if it's
// `requiredForVerification: true`, also add its key to the matching array in
// sync_verification_status() in schema.sql.
export const DOCUMENT_TYPES: DocumentTypeConfig[] = [
  {
    key: 'government_id',
    label: 'Government ID',
    ownerType: 'doctor',
    required: true,
    requiredForVerification: true,
    description: 'Aadhaar, PAN, or another government-issued photo ID - for identity/KYC.',
  },
  {
    key: 'medical_registration_certificate',
    label: 'Medical registration certificate',
    ownerType: 'doctor',
    required: true,
    requiredForVerification: true,
    hasNumber: true,
    hasExpiry: true,
    description: 'NMC (or state medical council) registration certificate, with the registration number.',
  },
  {
    key: 'degree_certificate',
    label: 'Degree / qualification certificate',
    ownerType: 'doctor',
    required: true,
    requiredForVerification: true,
    description: 'MBBS or highest medical qualification certificate.',
  },
  {
    key: 'doctor_clinic_association_proof',
    label: 'Doctor–clinic association proof',
    ownerType: 'doctor',
    required: true,
    requiredForVerification: true,
    description: 'Appointment letter, or a clinic letter confirming this doctor practises here.',
  },
  {
    key: 'doctor_photo',
    label: 'Photo',
    ownerType: 'doctor',
    required: true,
    requiredForVerification: true,
    description: 'A clear, recent photo of the doctor - shown on their profile once approved.',
  },
  {
    key: 'written_consent',
    label: 'Agreement signed (written consent)',
    ownerType: 'doctor',
    required: false, // not part of the submission gate - that's checked directly against `consents`
    requiredForVerification: true,
    autoManaged: true,
    description: 'Confirms the doctor has signed the onboarding agreement to join SanjeevniOS.',
  },
  {
    key: 'clinic_registration_certificate',
    label: 'Clinic registration certificate',
    ownerType: 'clinic',
    // Section 45 - part of the clinic's own submission gate now (a "not
    // applicable" claim still satisfies it, same mechanism the doctor gate
    // already treats as "not missing" - see enforce_clinic_submission_requirements()).
    required: true,
    requiredForVerification: true,
    allowNotApplicable: true,
    description:
      'Clinical Establishments Act registration certificate. Mark "Not applicable" if your state doesn\'t require one, with a note explaining why.',
  },
  {
    key: 'clinic_address_proof',
    label: 'Address / ID proof',
    ownerType: 'clinic',
    required: true,
    requiredForVerification: true,
    description: 'A utility bill, rent agreement, or property document confirming the clinic\'s address.',
  },
  {
    key: 'clinic_license',
    label: 'Practice license',
    ownerType: 'clinic',
    required: true,
    requiredForVerification: true,
    allowNotApplicable: true,
    description: 'Any additional license your local law requires to operate this clinic, if applicable.',
  },
  {
    key: 'map_location',
    label: 'Map location set',
    ownerType: 'clinic',
    required: false,
    requiredForVerification: true,
    autoManaged: true,
    description: 'Confirms the clinic has placed its pin at its exact location on the map.',
  },
];

export function docTypesFor(ownerType: OwnerType): DocumentTypeConfig[] {
  return DOCUMENT_TYPES.filter((d) => d.ownerType === ownerType);
}

// Same as docTypesFor, minus auto-managed items - what the owner's own
// upload screen (DocumentChecklist.tsx) should render.
export function uploadableDocTypesFor(ownerType: OwnerType): DocumentTypeConfig[] {
  return DOCUMENT_TYPES.filter((d) => d.ownerType === ownerType && !d.autoManaged);
}

export function requiredDocTypesFor(ownerType: OwnerType): DocumentTypeConfig[] {
  return DOCUMENT_TYPES.filter((d) => d.ownerType === ownerType && d.required);
}

export function docTypeConfig(key: string): DocumentTypeConfig | undefined {
  return DOCUMENT_TYPES.find((d) => d.key === key);
}
