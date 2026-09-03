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

export type HasKnownConditions = 'yes' | 'no' | 'not_answered';

export interface FamilyMember {
  id: string;
  account_id: string;
  name: string;
  relation: FamilyRelation | null;
  dob: string | null; // ISO date, e.g. "1990-05-12"
  phone: string | null;
  gender: Gender | null;
  guardian_consent: boolean;
  mrn: string; // "MRN-00012456" - permanent, server-generated, see schema.sql section 18
  photo_path: string | null; // path in the 'patient-photos' bucket - see schema.sql section 35.1
  govt_id: string | null;
  email: string | null;
  blood_group: string | null;
  city: string | null;
  has_known_conditions: HasKnownConditions;
  known_conditions_other: string | null;
  conditions_updated_at: string | null;
  created_at: string;
}

export interface ConditionRef {
  id: string;
  name: string;
  is_active: boolean;
}

export interface PatientCondition {
  id: string;
  patient_id: string;
  condition_id: string;
  created_at: string;
}

export interface Encounter {
  id: string;
  encounter_no: string; // "E-00014578" - permanent, server-generated
  mrn: string;
  patient_id: string; // family_members.id
  clinic_id: string;
  doctor_id: string;
  department: string | null;
  visit_datetime: string;
  visit_type: string;
  reason: string | null;
  status: string;
  created_at: string;
}

export type ClinicStatus = 'pending' | 'approved' | 'rejected';

// How a clinic takes patients: 'allow_walkins' is the default everything-as-
// before mode; 'appointment_only' is advance-booking with a daily cap and no
// walk-ins at all. See schema.sql section 33.
export type ClinicMode = 'allow_walkins' | 'appointment_only';
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
  // Arrival settings - see schema.sql sections 27, 28 and 29.
  checkin_grace_minutes: number;
  timezone: string;
  self_checkin_enabled: boolean;
  self_checkin_require_location: boolean;
  self_checkin_radius_m: number;
  no_show_cutoff_minutes: number;
  reminder_limit: number;
  // Online-payment perks (section 32) - convenience only, never priority.
  fast_checkin_paid_online: boolean;
  auto_confirm_paid_online: boolean;
  reschedule_window_hours: number;
  reschedule_window_hours_paid_online: number;
  // Booking mode (section 33).
  mode: ClinicMode;
  booking_horizon_days: number;
  daily_cap: number;
  // Same-day booking on top of appointment_only mode (section 37) - all off
  // by default, so an existing appointment_only clinic behaves exactly as
  // before until it opts in.
  same_day_booking_enabled: boolean;
  same_day_cutoff_minutes: number;
  auto_checkin_verified_same_day: boolean;
  same_day_checkin_radius_m: number;
  // The published-schedule estimate (section 34): where the running clock
  // starts, and how many minutes it advances per patient.
  publish_start_time: string;
  avg_minutes_per_patient: number;
  created_at: string;
}

// booked -> accepted -> checked_in -> called -> in_consultation -> completed,
// plus the three exits (cancelled by the patient, rejected by the clinic,
// no_show). A token only exists from 'checked_in' onwards - see
// check_in_appointment() in schema.sql section 27.
export type AppointmentStatus =
  | 'booked'
  | 'accepted'
  | 'checked_in'
  | 'called'
  | 'in_consultation'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'no_show';

export type CheckInMethod = 'clinic_scan' | 'patient_scan' | 'manual';

// Statuses where the patient has physically arrived and is waiting to be
// seen or being seen - i.e. everyone holding a live token today.
export const LIVE_QUEUE_STATUSES: AppointmentStatus[] = ['checked_in', 'called', 'in_consultation'];

export type PaymentMethod = 'online' | 'cod';
export type PaymentRowStatus = 'pending' | 'hold' | 'captured' | 'refunded';
export type PayoutStatus = 'pending' | 'paid';

// The appointment's own payment state. Entirely independent of whether the
// patient has physically arrived (checked_in_at) - paying online buys no
// queue priority whatsoever. See schema.sql section 30.
export type AppointmentPaymentStatus = 'pay_at_clinic' | 'paid_online' | 'paid_at_clinic' | 'refunded';

export const PAYMENT_STATUS_LABEL: Record<AppointmentPaymentStatus, string> = {
  pay_at_clinic: 'Pay at clinic',
  paid_online: 'Paid online',
  paid_at_clinic: 'Paid at clinic',
  refunded: 'Refunded',
};

export interface Payment {
  id: string;
  appointment_id: string;
  amount: number;
  method: PaymentMethod;
  status: PaymentRowStatus;
  payout_status: PayoutStatus;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  type: string | null;
  message: string;
  read: boolean;
  at: string;
  appointment_id: string | null;
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

export type ConsentType = 'platform_disclaimer' | 'dpdp_data_consent';

export interface PatientDeclaration {
  id: string;
  patient_id: string;
  declaration_version: string;
  consent_type: ConsentType;
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
  // How many patients ONE computed slot in this window can hold - section 36.
  slot_capacity: number;
}

export interface ClinicHoliday {
  id: string;
  clinic_id: string;
  date: string; // ISO date
  reason: string | null;
}

export type PatientType = 'scheduled' | 'walk_in';

export interface Appointment {
  id: string;
  member_id: string;
  doctor_id: string;
  clinic_id: string;
  date: string; // ISO date
  slot_time: string; // "HH:MM:SS" - the booked slot, kept for reference; the serving order follows arrival, not this
  status: AppointmentStatus;
  // Null until the patient physically arrives and is checked in. Issued in
  // arrival order, per clinic, per day, and never moves afterwards.
  token_number: number | null;
  token_date: string | null;
  arrival_seq: number | null;
  checked_in_at: string | null;
  checked_in_by: string | null;
  check_in_method: CheckInMethod | null;
  patient_type: PatientType;
  // Payment and presence are separate facts - see schema.sql section 30.
  payment_status: AppointmentPaymentStatus;
  // Optional per-appointment override of the clinic's grace window; null
  // means "use the clinic setting".
  grace_minutes: number | null;
  // What the queue sorts on - see schema.sql section 30.3.
  effective_order_time: string | null;
  // Arrived after their slot had already ended. Recorded for the clinic's
  // information only - a late arrival still gets a normal arrival-order
  // token. See schema.sql section 29.
  was_late: boolean;
  no_show_marked_at: string | null;
  no_show_auto: boolean;
  skip_count: number;
  encounter_id: string | null;
  reason: string | null;
  // The published running order (section 34) - a PLAN, assigned the night
  // before to every booked patient. Entirely separate from token_number:
  // that one is only ever assigned at the door, in arrival order, once this
  // patient has actually checked in. Null until the clinic has published
  // this appointment's day at least once.
  sequence_no: number | null;
  estimated_time: string | null;
  schedule_published_at: string | null;
  // The clinic's manual reorder of the published sequence; null means "use
  // slot time". Not meaningful once schedule_published_at is null.
  day_order_override: number | null;
  // A location fix taken at booking time, for a same-day booking made
  // through the patient's own app (section 37) - null for everyone else
  // (a walk-in, an advance booking, or a same-day booking made without
  // location access). Used once, by the server, to decide whether to
  // auto-check-in; kept afterwards only as a record of that decision.
  booking_lat: number | null;
  booking_lng: number | null;
  created_at: string;
}

// One row of clinic_schedule_breaks (section 34) - a gap the clinic blocks
// out of the published running order, e.g. a lunch break, positioned by
// where it falls in the FINAL sequence rather than by clock time so it holds
// even as the clinic reorders people around it.
export interface ScheduleBreak {
  id: string;
  clinic_id: string;
  date: string;
  before_seq: number;
  minutes: number;
  label: string | null;
  created_at: string;
}

// A row of preview_day_schedule() / publish_day_schedule() - what the
// clinic sees before, and confirms after, publishing a day.
export interface DayScheduleRow {
  appointment_id: string;
  seq: number;
  estimated_time: string;
  member_name: string;
  doctor_name: string;
  slot_time: string;
  status: AppointmentStatus;
  patient_type: PatientType;
  day_order_override: number | null;
}

// Shape returned by the check_in_appointment() RPC.
export interface CheckInResult {
  token_number: number;
  arrival_seq: number;
  token_date: string;
  already_checked_in: boolean;
  was_late: boolean;
}

// Row shape returned by the lookup_checkin() RPC (schema.sql section 35.2) -
// everything the scan-preview card needs, before anyone is actually checked
// in. sequence_no/estimated_time are the night-before PLAN (section 34);
// token_number is only ever set once already_checked_in is true.
export interface CheckInLookup {
  appointmentId: string;
  memberId: string;
  patientName: string;
  photoPath: string | null;
  mrn: string;
  dob: string | null;
  gender: Gender | null;
  status: AppointmentStatus;
  alreadyCheckedIn: boolean;
  tokenNumber: number | null;
  sequenceNo: number | null;
  estimatedTime: string | null;
  slotTime: string;
  doctorName: string;
  paymentStatus: AppointmentPaymentStatus;
  amountDue: number | null;
}

// Row shape returned by the get_queue_status() RPC - just enough to render
// the live "now serving" counter, nothing that identifies a patient.
// A row of get_queue_status() - the live queue as a patient may see it:
// ordered and positioned by the fair-queue rule, carrying nothing that
// identifies anyone. See schema.sql section 31.
export interface QueueStatusRow {
  queue_position: number;
  token_number: number;
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
