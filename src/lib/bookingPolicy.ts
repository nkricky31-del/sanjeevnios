import { addDaysISO, todayISO } from './date';
import { supabase } from './supabaseClient';

export type ClinicMode = 'allow_walkins' | 'appointment_only';

export interface BookingPolicy {
  mode: ClinicMode;
  bookingHorizonDays: number;
  dailyCap: number;
  // Same-day booking on top of appointment_only mode (schema.sql section
  // 37) - meaningless outside that mode, where same-day is already open.
  sameDayBookingEnabled: boolean;
  sameDayCutoffMinutes: number;
}

export interface DayAvailability {
  seatsTaken: number;
  dailyCap: number;
  seatsLeft: number;
  isFull: boolean;
}

export const DEFAULT_POLICY: BookingPolicy = {
  mode: 'allow_walkins',
  bookingHorizonDays: 1,
  dailyCap: 100,
  sameDayBookingEnabled: false,
  sameDayCutoffMinutes: 30,
};

export async function getBookingPolicy(clinicId: string): Promise<BookingPolicy> {
  const { data } = await supabase
    .from('clinics')
    .select('mode, booking_horizon_days, daily_cap, same_day_booking_enabled, same_day_cutoff_minutes')
    .eq('id', clinicId)
    .maybeSingle();
  if (!data) return DEFAULT_POLICY;
  return {
    mode: (data.mode ?? 'allow_walkins') as ClinicMode,
    bookingHorizonDays: data.booking_horizon_days ?? 1,
    dailyCap: data.daily_cap ?? 100,
    sameDayBookingEnabled: data.same_day_booking_enabled ?? false,
    sameDayCutoffMinutes: data.same_day_cutoff_minutes ?? 30,
  };
}

export async function getDayAvailability(clinicId: string, date: string): Promise<DayAvailability | null> {
  const { data } = await supabase.rpc('day_availability', { p_clinic_id: clinicId, p_date: date });
  const row = ((data ?? []) as {
    seats_taken: number;
    daily_cap: number;
    seats_left: number;
    is_full: boolean;
  }[])[0];
  if (!row) return null;
  return {
    seatsTaken: row.seats_taken,
    dailyCap: row.daily_cap,
    seatsLeft: row.seats_left,
    isFull: row.is_full,
  };
}

export async function getNextAvailableDay(clinicId: string): Promise<string | null> {
  const { data } = await supabase.rpc('next_available_day', { p_clinic_id: clinicId });
  return (data as string | null) ?? null;
}

export async function joinWaitlist(
  clinicId: string,
  memberId: string,
  date: string,
  doctorId?: string | null
): Promise<{ place?: number; alreadyWaiting?: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('join_waitlist', {
    p_clinic_id: clinicId,
    p_member_id: memberId,
    p_date: date,
    p_doctor_id: doctorId ?? null,
  });
  if (error) return { error: error.message };
  const row = ((data ?? []) as { place: number; already_waiting: boolean }[])[0];
  return { place: row?.place, alreadyWaiting: row?.already_waiting };
}

// The first and last dates a patient may pick, given the clinic's mode. In
// appointment_only the earliest is TOMORROW - same-day booking is exactly
// what that mode exists to prevent - UNLESS the clinic has opted into
// same-day booking on top of it (schema.sql section 37), in which case today
// is offered too. The database enforces every end of this regardless (see
// enforce_booking_policy in schema.sql section 33/37); this is only so the
// day strip doesn't offer days that would be refused.
export function bookableRange(policy: BookingPolicy): { firstISO: string; lastISO: string; days: number } {
  const today = todayISO();
  const offset = policy.mode === 'appointment_only' && !policy.sameDayBookingEnabled ? 1 : 0;
  const firstISO = addDaysISO(today, offset);
  const lastISO = addDaysISO(today, policy.bookingHorizonDays);
  // Inclusive count of selectable days.
  const days = Math.max(policy.bookingHorizonDays - offset + 1, 1);
  return { firstISO, lastISO, days };
}

// The DB raises 'FULL_DAY: ...' when the cap is reached. The prefix lets the
// UI recognise that specific refusal and offer the waitlist, rather than
// showing a database error and leaving the patient with nowhere to go.
export function isFullDayError(message: string | undefined): boolean {
  return !!message && message.includes('FULL_DAY');
}

// The DB raises 'SLOT_FULL: ...' when someone else took the last seat in a
// slot between the picker loading and Confirm being pressed - see
// enforce_slot_capacity() in schema.sql section 36.4. Same idea as
// isFullDayError above: let the UI send the patient back to pick a different
// (now-refreshed) slot instead of showing a raw database error.
export function isSlotFullError(message: string | undefined): boolean {
  return !!message && message.includes('SLOT_FULL');
}

// The DB raises 'SAME_DAY_CUTOFF: ...' when a same-day scheduled slot is
// already inside (or past) the clinic's same_day_cutoff_minutes window - see
// enforce_booking_policy in schema.sql section 37.3. Same idea as the two
// helpers above: recognise the specific refusal so the UI can send the
// patient back to pick a later time instead of showing a raw database error.
export function isSameDayCutoffError(message: string | undefined): boolean {
  return !!message && message.includes('SAME_DAY_CUTOFF');
}
