export type Role = 'patient' | 'clinic' | 'admin';

export interface Profile {
  id: string;
  role: Role;
  name: string | null;
  phone: string | null;
  created_at: string;
}

export type FamilyRelation = 'self' | 'spouse' | 'child' | 'parent';

export interface FamilyMember {
  id: string;
  account_id: string;
  name: string;
  relation: FamilyRelation;
  dob: string; // ISO date, e.g. "1990-05-12"
  guardian_consent: boolean;
  created_at: string;
}

export type ClinicStatus = 'pending' | 'approved' | 'rejected';
export type DoctorStatus = 'pending' | 'approved' | 'rejected';

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

// Result row from the search_doctors() RPC - a flattened doctor+clinic pair.
export interface DoctorSearchResult {
  doctor_id: string;
  doctor_name: string;
  specialty: string | null;
  clinic_id: string;
  clinic_name: string;
  clinic_address: string | null;
}

export interface Doctor {
  id: string;
  clinic_id: string;
  name: string;
  reg_no: string | null;
  specialty: string | null;
  status: DoctorStatus;
  consultation_fee: number;
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
