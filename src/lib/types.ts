export type Role = 'patient' | 'clinic' | 'admin';

export interface Profile {
  id: string;
  role: Role;
  name: string | null;
  phone: string | null;
  suspended: boolean;
  // Section 44 - gates the whole patient app (see PatientOnboardingGate.tsx)
  // until the first-login profile form is saved. Backfilled to true for
  // every pre-existing patient at migration time.
  onboarding_complete: boolean;
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
  // Section 44 - required at onboarding, editable later from Profile.
  address: string | null;
  pincode: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
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

// 'draft' (section 45) - registered, but not yet submitted for admin review.
// Invisible to admin/search exactly like 'pending' already was to patients.
export type ClinicStatus = 'draft' | 'pending' | 'approved' | 'rejected';

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

// Section 43 - replaces the hardcoded TIERS constant as the real source of
// truth for a clinic's booking limit and commission rate. `tier` (the older
// free/pro/premium label) is left in place for backward compatibility with
// AdminSubscriptions.tsx's manual override, but plan_id/plans.booking_limit
// is what enforce_clinic_booking_limit() actually reads now.
export interface Plan {
  id: string;
  name: string;
  monthly_price: number;
  booking_limit: number | null;
  per_booking_commission: number;
  razorpay_plan_id: string | null;
  active: boolean;
  created_at: string;
}

export type BillingStatus = 'active' | 'past_due';

export interface Subscription {
  id: string;
  clinic_id: string;
  tier: SubscriptionTier;
  bookings_used: number;
  period_start: string | null;
  period_end: string | null;
  plan_id: string | null;
  razorpay_subscription_id: string | null;
  // The real Razorpay billing cycle's end - distinct from period_end above,
  // which is only the monthly usage-count reset window.
  current_period_end: string | null;
  billing_status: BillingStatus;
  past_due_since: string | null;
}

export interface Invoice {
  id: string;
  clinic_id: string;
  period_start: string;
  period_end: string;
  amount: number;
  status: 'paid' | 'failed';
  razorpay_invoice_id: string | null;
  razorpay_payment_id: string | null;
  created_at: string;
}

export interface CommissionLedgerEntry {
  id: string;
  clinic_id: string;
  appointment_id: string;
  net_amount: number;
  commission_rate: number;
  platform_fee: number;
  created_at: string;
}

export interface Clinic {
  id: string;
  owner_id: string;
  name: string;
  reg_no: string | null;
  address: string | null;
  contact_phone: string | null;
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
  // How many minutes before the slot an accepted patient should aim to
  // report - clamped to the 60-minute check-in window wherever it's actually
  // used (see lib/time.ts's reportingTimeFor). Section 40.
  report_before_minutes: number;
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

// Who funds a coupon's discount - see payouts.ts. Null when no coupon was used.
export type CouponFundedBy = 'platform' | 'clinic';

export interface Payment {
  id: string;
  appointment_id: string;
  // The real transactional figure - always equal to net_amount. Kept as its
  // own column (rather than renamed) so every pre-existing reader of
  // `amount` (payouts.ts, Payments.tsx, AdminPayments.tsx) keeps working
  // unchanged. See migration_41_coupons_and_razorpay.sql.
  amount: number;
  method: PaymentMethod;
  status: PaymentRowStatus;
  payout_status: PayoutStatus;
  // The doctor's fee plus the platform convenience fee (online only),
  // before any coupon discount. Null on a payment row created before
  // section 41.
  gross_amount: number | null;
  coupon_code: string | null;
  discount_amount: number;
  net_amount: number | null;
  funded_by: CouponFundedBy | null;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  created_at: string;
}

// Which wire a notification actually went out on. 'in_app' always exists for
// every notice; 'whatsapp'/'sms' rows only exist when that leg was actually
// sent - see notify.ts and migration_39_two_step_confirmation_notifications.sql.
export type NotificationChannel = 'in_app' | 'whatsapp' | 'sms';

export interface Notification {
  id: string;
  user_id: string;
  type: string | null;
  message: string;
  read: boolean;
  at: string;
  appointment_id: string | null;
  channel: NotificationChannel;
}

// The coupons table itself is never read directly by the patient-facing app
// (see migration_41/42's headers - only validate_and_price() can tell a
// patient anything about a code) - this type is for the admin screen
// (AdminCoupons.tsx), which IS allowed to read/write it directly.
export type CouponType = 'flat' | 'percent';
// Only value this app produces today - see validate_and_price()'s own note
// on why it's still checked rather than assumed.
export type CouponAppliesTo = 'app_booking';

export interface Coupon {
  id: string;
  code: string;
  description: string | null;
  type: CouponType;
  value: number;
  // Percent-type only; ignored (and should be null) for a flat coupon.
  max_discount: number | null;
  min_amount: number;
  valid_from: string | null;
  valid_to: string | null;
  // null = unlimited for either.
  per_user_limit: number | null;
  total_limit: number | null;
  times_used: number;
  funded_by: CouponFundedBy;
  applies_to: CouponAppliesTo;
  // null = valid at every clinic.
  clinic_id: string | null;
  active: boolean;
  created_at: string;
}

export type CouponRedemptionStatus = 'reserved' | 'confirmed' | 'released';

export interface CouponRedemption {
  id: string;
  coupon_id: string;
  appointment_id: string | null;
  // The ACCOUNT holder (profiles.id), not a specific family member - see
  // migration_42's header for why per_user_limit is scoped this way.
  patient_id: string;
  discount_amount: number;
  status: CouponRedemptionStatus;
  reserved_at: string;
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
