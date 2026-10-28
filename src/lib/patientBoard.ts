import type { PatientContact } from './patientContact';
import { formatTimeLabel } from './time';
import type { AppointmentPaymentStatus, AppointmentStatus } from './types';

// One row of the board: an appointment, with its doctor and the front desk's
// view of the patient (get_patient_contacts - name, age, gender, phone, MRN).
export interface BoardRow {
  id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  checked_in_at: string | null;
  check_in_method: string | null;
  token_number: number | null;
  payment_status: AppointmentPaymentStatus;
  paid_amount: number | null;
  reason: string | null;
  created_at: string;
  patient_type: string | null;
  member_id: string;
  doctor_id: string;
  reject_reason: string | null;
  was_late: boolean | null;
  doctors: { name: string; specialty: string | null } | null;
  encounters: { encounter_no: string } | null;
  payments: { amount: number | null; net_amount: number | null; method: string; status: string }[] | null;
  family_members: PatientContact | null;
}

export const BOARD_COLUMNS =
  'id, date, slot_time, status, checked_in_at, check_in_method, token_number, payment_status, paid_amount, reason, created_at, patient_type, member_id, doctor_id, reject_reason, was_late, doctors(name, specialty), encounters(encounter_no), payments(amount, net_amount, method, status)';

export const BOARD_STATUS: Record<AppointmentStatus, { label: string; tone: 'live' | 'warning' | 'info' | 'neutral' | 'danger' }> = {
  booked: { label: 'Pending', tone: 'warning' },
  accepted: { label: 'Confirmed', tone: 'info' },
  checked_in: { label: 'Waiting', tone: 'live' },
  called: { label: 'Called', tone: 'live' },
  in_consultation: { label: 'With doctor', tone: 'live' },
  completed: { label: 'Done', tone: 'info' },
  no_show: { label: 'No-show', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  rejected: { label: 'Declined', tone: 'neutral' },
};

export const isCheckedIn = (r: Pick<BoardRow, 'checked_in_at'>) => r.checked_in_at != null;

// A timestamp as a clock time in the same style as slot times ("6:01 PM"),
// whatever the device's language settings would otherwise pick.
export const timeOf = (iso: string) => {
  const d = new Date(iso);
  return formatTimeLabel(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`);
};
export const isCancelled = (r: Pick<BoardRow, 'status'>) => r.status === 'cancelled' || r.status === 'rejected';
