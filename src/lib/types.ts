export type Role = 'patient' | 'clinic' | 'admin';

export interface Profile {
  id: string;
  role: Role;
  name: string | null;
  phone: string | null;
  suspended: boolean;
  created_at: string;
}

export type FamilyRelation = 'self' | 'spouse' | 'child' | 'parent';
export type Gender = 'male' | 'female' | 'other';

export interface FamilyMember {
  id: string;
  account_id: string;
  name: string;
  relation: FamilyRelation | null;
  dob: string | null; // ISO date, e.g. "1990-05-12"
  phone: string | null;
  gender: Gender | null;
  guardian_consent: boolean;
  created_at: string;
}

export type ClinicStatus = 'pending' | 'approved' | 'rejected';
// 'draft': added by the clinic but onboarding (consent + required
// documents) isn't complete yet - invisible to admin, same as 'pending'
// already was to patients. See enforce_doctor_submission_requirements() in
// schema.sql for what moves a doctor from draft to pending.
export type DoctorStatus = 'draft' | 'pending' | 'approved' | 'rejected';
export type SubscriptionTier = 'free' | 'pro' | 'premium';

export interface Subscription {
  id: string;
  clinic_id: string;
  tier: SubscriptionTier;
  bookings_used: number;
  period_start: string | null;
  period_end: string | null;
}

export interface Clinic {
  id: string;
  owner_id: string;
  name: string;
  reg_no: string | null;
  address: string | null;
  status: ClinicStatus;
  reject_reason: string | null;
  registration_doc_path: string | null;
  lat: number | null;
  lng: number | null;
  formatted_address: string | null;
  subscription_tier: string;
  is_active: boolean;
  is_verified: boolean;
  verified_at: string | null;
  verified_by: string | null;
  created_at: string;
}

export type AppointmentStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'in_progress'
  | 'done'
  | 'no_show';

export type PaymentMethod = 'online' | 'cod';
export type PaymentRowStatus = 'pending' | 'hold' | 'captured' | 'refunded';
export type PayoutStatus = 'pending' | 'paid';

export interface Payment {
  id: string;
  appointment_id: string;
  amount: number;
  method: PaymentMethod;
  status: PaymentRowStatus;
  payout_status: PayoutStatus;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  actor: string | null;
  action: string;
  target: string | null;
  at: string;
}

export type OwnerType = 'clinic' | 'doctor';
export type DocumentStatus = 'pending' | 'verified' | 'rejected';

export interface DocumentRow {
  id: string;
  owner_type: OwnerType;
  owner_id: string;
  doc_type: string;
  storage_path: string | null;
  number: string | null;
  expiry_date: string | null;
  not_applicable: boolean;
  not_applicable_note: string | null;
  status: DocumentStatus;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface Consent {
  id: string;
  doctor_id: string;
  agreement_version: string;
  signature_name: string;
  agreed_at: string;
  ip: string | null;
  file_url: string | null;
}

export interface PatientDeclaration {
  id: string;
  patient_id: string;
  declaration_version: string;
  accepted_at: string;
  ip: string | null;
}

// Result row from the search_doctors() RPC - a flattened doctor+clinic pair.
export interface DoctorSearchResult {
  doctor_id: string;
  doctor_name: string;
  specialty: string | null;
  clinic_id: string;
  clinic_name: string;
  clinic_address: string | null;
  clinic_lat: number | null;
  clinic_lng: number | null;
  doctor_verified: boolean;
  clinic_verified: boolean;
}

export interface Doctor {
  id: string;
  clinic_id: string;
  name: string;
  reg_no: string | null;
  specialty: string | null;
  status: DoctorStatus;
  reject_reason: string | null;
  registration_doc_path: string | null;
  consultation_fee: number;
  is_verified: boolean;
  verified_at: string | null;
  verified_by: string | null;
  created_at: string;
}

export interface DoctorAvailability {
  id: string;
  doctor_id: string;
  weekday: number; // 0 = Sunday ... 6 = Saturday
  start_time: string; // "HH:MM:SS"
  end_time: string;
  max_patients_per_day: number;
}

export interface Appointment {
  id: string;
  member_id: string;
  doctor_id: string;
  clinic_id: string;
  date: string; // ISO date
  slot_time: string; // "HH:MM:SS"
  status: AppointmentStatus;
  token_no: number | null;
  payment_status: string;
  created_at: string;
}

// Row shape returned by the get_queue_status() RPC - just enough to render
// the live "now serving" counter, nothing that identifies a patient.
export interface QueueStatusRow {
  token_no: number;
  status: AppointmentStatus;
}

export interface PrescriptionDrug {
  name: string;
  dosage: string;
  frequency: string;
  durationDays: number;
}

export interface Visit {
  id: string;
  appointment_id: string;
  notes: string | null;
  diagnosis: string | null;
  follow_up_date: string | null;
  no_prescription: boolean;
  created_at: string;
}

export interface Prescription {
  id: string;
  visit_id: string;
  items: PrescriptionDrug[];
  file_url: string | null;
  signed_by: string | null;
  status: string;
  created_at: string;
}

export type FileCategory = 'lab_report' | 'prescription' | 'xray' | 'photo';

export interface AppointmentFile {
  id: string;
  member_id: string | null;
  appointment_id: string | null;
  type: FileCategory | null;
  storage_path: string;
  created_at: string;
}
