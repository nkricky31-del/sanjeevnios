import { supabase } from './supabaseClient';
import type { CheckInLookup, CheckInMethod, CheckInResult } from './types';

// ---------------------------------------------------------------------------
// Booking QR (what the patient shows at reception)
// ---------------------------------------------------------------------------
// The code itself is minted by the DATABASE, not here: issue_booking_qr()
// signs (appointment, expiry) with a server-side secret the client never
// sees, so a code can't be manufactured by anyone who merely learns an
// appointment id. See schema.sql section 28.
export interface BookingQr {
  code: string;
  expiresAt: string;
}

export async function issueBookingQr(appointmentId: string): Promise<BookingQr | { error: string }> {
  const { data, error } = await supabase.rpc('issue_booking_qr', { p_appointment_id: appointmentId });
  if (error) return { error: error.message };
  const row = ((data ?? []) as { code: string; expires_at: string }[])[0];
  if (!row) return { error: 'Could not create a check-in code.' };
  return { code: row.code, expiresAt: row.expires_at };
}

// Cheap client-side shape check so the scanner can say "that isn't one of
// our codes" without a round trip. It deliberately does NOT try to judge
// validity - the signature and expiry are only ever checked server-side.
export function looksLikeBookingQr(raw: string): boolean {
  return /^sanjeevni:appt:v2:[0-9a-f-]{36}:\d+:[0-9a-f]{16}$/i.test(raw.trim());
}

export function looksLikeClinicQr(raw: string): boolean {
  return /^sanjeevni:clinic:v1:[0-9a-f-]{36}:\d+:[0-9a-f]{16}$/i.test(raw.trim());
}

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

export interface CheckInOutcome {
  ok: boolean;
  token?: number;
  alreadyCheckedIn?: boolean;
  wasLate?: boolean;
  error?: string;
}

function toOutcome(data: unknown, error: { message: string } | null): CheckInOutcome {
  if (error) return { ok: false, error: error.message };
  const result = ((data ?? []) as CheckInResult[])[0];
  if (!result || result.token_number == null) {
    return { ok: false, error: 'Check-in did not return a token - please try again.' };
  }
  return {
    ok: true,
    token: result.token_number,
    alreadyCheckedIn: result.already_checked_in,
    wasLate: result.was_late,
  };
}

// Manual check-in by the desk ("Mark arrived"), and the walk-in path.
//
// allowLate is the desk overriding the timing rules to admit someone whose
// window has closed, or who was already written off as a no-show but has
// turned up after all. The database refuses this from a patient session, so
// it can only ever be a clinic decision.
export async function checkInAppointment(
  appointmentId: string,
  method: CheckInMethod,
  allowLate = false
): Promise<CheckInOutcome> {
  const { data, error } = await supabase.rpc('check_in_appointment', {
    p_appointment_id: appointmentId,
    p_method: method,
    p_allow_late: allowLate,
  });
  return toOutcome(data, error);
}

// Writes off everyone who never arrived, once the clinic's cut-off has
// passed. The console calls this when it loads, so the sweep happens even on
// projects where pg_cron isn't available. Returns how many were marked.
export async function autoMarkNoShows(clinicId: string): Promise<number> {
  const { data, error } = await supabase.rpc('auto_mark_no_shows', { p_clinic_id: clinicId });
  if (error) return 0;
  return (data as number) ?? 0;
}

// Called, didn't come forward: draw them a fresh token at the back rather
// than writing them off entirely.
export async function skipToBack(appointmentId: string): Promise<{ token?: number; error?: string }> {
  const { data, error } = await supabase.rpc('skip_to_back', { p_appointment_id: appointmentId });
  if (error) return { error: error.message };
  const row = ((data ?? []) as { token_number: number }[])[0];
  return row ? { token: row.token_number } : { error: 'Could not skip this patient.' };
}

// The clinic scanning a patient's booking QR. Signature and expiry are
// verified inside the database before anything is written.
export async function checkInWithQr(code: string): Promise<CheckInOutcome> {
  const { data, error } = await supabase.rpc('check_in_with_qr', { p_code: code.trim() });
  return toOutcome(data, error);
}

// ---------------------------------------------------------------------------
// The scan/patient-ID preview (schema.sql section 35.2) - read-only, never
// checks anyone in. Pass exactly one of code/mrn.
// ---------------------------------------------------------------------------

interface LookupCheckInRow {
  appointment_id: string;
  member_id: string;
  patient_name: string;
  photo_path: string | null;
  mrn: string;
  dob: string | null;
  gender: CheckInLookup['gender'];
  status: CheckInLookup['status'];
  already_checked_in: boolean;
  token_number: number | null;
  sequence_no: number | null;
  estimated_time: string | null;
  slot_time: string;
  doctor_name: string;
  payment_status: CheckInLookup['paymentStatus'];
  amount_due: number | null;
}

export async function lookupCheckIn(
  clinicId: string,
  by: { code: string } | { mrn: string }
): Promise<CheckInLookup | { error: string }> {
  const { data, error } = await supabase.rpc('lookup_checkin', {
    p_clinic_id: clinicId,
    p_qr_code: 'code' in by ? by.code.trim() : null,
    p_mrn: 'mrn' in by ? by.mrn.trim() : null,
  });
  if (error) return { error: error.message };
  const row = ((data ?? []) as LookupCheckInRow[])[0];
  if (!row) return { error: 'No matching patient found.' };
  return {
    appointmentId: row.appointment_id,
    memberId: row.member_id,
    patientName: row.patient_name,
    photoPath: row.photo_path,
    mrn: row.mrn,
    dob: row.dob,
    gender: row.gender,
    status: row.status,
    alreadyCheckedIn: row.already_checked_in,
    tokenNumber: row.token_number,
    sequenceNo: row.sequence_no,
    estimatedTime: row.estimated_time,
    slotTime: row.slot_time,
    doctorName: row.doctor_name,
    paymentStatus: row.payment_status,
    amountDue: row.amount_due,
  };
}

// ---------------------------------------------------------------------------
// Self check-in (patient scans reception's rotating code)
// ---------------------------------------------------------------------------

export async function selfCheckIn(
  code: string,
  coords?: { lat: number; lng: number } | null
): Promise<CheckInOutcome> {
  const { data, error } = await supabase.rpc('self_check_in', {
    p_code: code.trim(),
    p_lat: coords?.lat ?? null,
    p_lng: coords?.lng ?? null,
  });
  return toOutcome(data, error);
}

// Best-effort location for the optional geofence. Resolves to null rather
// than rejecting when the patient declines or the device can't get a fix -
// whether that's fatal is the clinic's setting to decide, and the database
// makes that call, not this.
export function getCurrentCoords(timeoutMs = 8000): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs }
    );
  });
}

// ---------------------------------------------------------------------------
// Reception's rotating code (clinic side)
// ---------------------------------------------------------------------------

// What the patient's pass screen needs to know to explain the right thing:
// can they check themselves in at all, does it need location, did they pay
// online, how close to the appointment may they still reschedule, and when
// they should aim to report. All five are convenience/guidance facts - none
// of them affects queue order or when a token is actually assigned (that's
// still check-in, in arrival order - section 40).
export interface CheckInOptions {
  canSelfCheckIn: boolean;
  requiresLocation: boolean;
  paidOnline: boolean;
  rescheduleWindowHours: number;
  // "HH:MM:SS", already clamped to the check-in window server-side - see
  // get_checkin_options() in migration_40_reporting_time.sql.
  reportingTime: string;
}

export async function getCheckInOptions(appointmentId: string): Promise<CheckInOptions | null> {
  const { data, error } = await supabase.rpc('get_checkin_options', { p_appointment_id: appointmentId });
  if (error) return null;
  const row = ((data ?? []) as {
    can_self_check_in: boolean;
    requires_location: boolean;
    paid_online: boolean;
    reschedule_window_hours: number;
    reporting_time: string;
  }[])[0];
  if (!row) return null;
  return {
    canSelfCheckIn: row.can_self_check_in,
    requiresLocation: row.requires_location,
    paidOnline: row.paid_online,
    rescheduleWindowHours: row.reschedule_window_hours,
    reportingTime: row.reporting_time,
  };
}

export async function issueClinicCheckinCode(
  clinicId: string
): Promise<{ code: string; expiresAt: string } | { error: string }> {
  const { data, error } = await supabase.rpc('issue_clinic_checkin_code', { p_clinic_id: clinicId });
  if (error) return { error: error.message };
  const row = ((data ?? []) as { code: string; expires_at: string }[])[0];
  if (!row) return { error: 'Could not create a reception code.' };
  return { code: row.code, expiresAt: row.expires_at };
}
