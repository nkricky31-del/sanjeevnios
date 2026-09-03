import { addDaysISO } from './date';
import { supabase } from './supabaseClient';
import { computeSlots, formatTimeLabel, timeToMinutes } from './time';
import type { AppointmentStatus, DoctorAvailability, QueueStatusRow } from './types';

// A short, stable identifier for a booking, available from the moment it's
// made - unlike the token, which doesn't exist until the patient arrives.
// This is what the patient quotes at the desk if they turn up before
// check-in has happened. Derived from the appointment's own id, so it never
// changes.
export function bookingReference(appointmentId: string): string {
  return appointmentId.slice(0, 8).toUpperCase();
}

// Whoever the doctor is with right now. get_queue_status() already returns
// the queue in fair-queue order (schema.sql section 31), so "now serving" is
// the token of whoever is called/in consultation, or the token at the front
// of the order if the doctor is between patients. Note this is NOT the
// lowest token: a punctual 3PM patient sits ahead of a punctual 4PM patient
// even if the 4PM one arrived first and holds the lower number.
export function computeNowServing(dayQueue: QueueStatusRow[]): number | null {
  if (dayQueue.length === 0) return null;

  const active = dayQueue.find((r) => r.status === 'in_consultation' || r.status === 'called');
  if (active) return active.token_number;

  return dayQueue[0]?.token_number ?? null;
}

// This patient's own place in line, and how many are in front of them - both
// taken from the server's ordering rather than recomputed here, so the
// number on the patient's phone matches the one at the desk.
export function findMyPosition(dayQueue: QueueStatusRow[], myToken: number | null): number | null {
  if (myToken == null) return null;
  return dayQueue.find((r) => r.token_number === myToken)?.queue_position ?? null;
}

export function countAhead(dayQueue: QueueStatusRow[], myToken: number | null): number | null {
  const mine = findMyPosition(dayQueue, myToken);
  if (mine == null) return null;
  // Position is 1-based, so everyone before you is position - 1.
  return Math.max(mine - 1, 0);
}

// The slot a walk-in standing at the desk right now should be booked into:
// the current time's slot bucket, if it still has room and its check-in
// window (schema.sql section 27.7's [slot - 60min, slot end + grace]) hasn't
// closed yet, else the soonest slot still ahead. Slots already full
// (takenSlots, capacity-aware since migration 36) are skipped; a slot whose
// window has fully closed is skipped too rather than handed to the caller,
// since check_in_appointment() would only refuse it as "too late" anyway.
// A slot's own length isn't known here (that's slot_minutes_for(), server
// side) - the gap to the NEXT computed slot stands in for it, which is
// exactly what that arithmetic produces in the first place; the day's last
// slot borrows the previous gap (or a flat hour if it's the only one).
//
// Returns null when nothing today is both open and still reachable - the
// caller's job at that point is to offer the waitlist or another day, not
// to retry.
export function findWalkInSlot(allSlots: string[], takenSlots: Set<string>, nowHHMMSS: string, graceMinutes: number): string | null {
  const nowMin = timeToMinutes(nowHHMMSS);

  for (let i = 0; i < allSlots.length; i++) {
    const s = allSlots[i];
    if (takenSlots.has(s)) continue;
    const start = timeToMinutes(s);
    if (start > nowMin) return s; // hasn't started yet - soonest open slot ahead
    const gap =
      i + 1 < allSlots.length
        ? timeToMinutes(allSlots[i + 1]) - start
        : i > 0
          ? start - timeToMinutes(allSlots[i - 1])
          : 60;
    if (nowMin <= start + gap + graceMinutes) return s; // still inside this bucket's window
    // else this open slot's window already closed - keep looking forward
  }
  return null;
}

const NEXT_SLOT_SEARCH_DAYS = 7;

// Used when the clinic rejects a booking: finds the soonest open slot for
// the SAME doctor, starting from the rejected appointment's own date and
// looking up to a week ahead, so the rejection notice can hand the patient
// a concrete alternative instead of just "try again".
export async function findNextBestSlot(
  doctorId: string,
  fromDateISO: string
): Promise<{ date: string; slotTime: string } | null> {
  const { data: availData } = await supabase.from('doctor_availability').select('*').eq('doctor_id', doctorId);
  const availability = (availData ?? []) as DoctorAvailability[];
  if (availability.length === 0) return null;

  for (let i = 0; i < NEXT_SLOT_SEARCH_DAYS; i++) {
    const dateISO = addDaysISO(fromDateISO, i);
    const weekday = new Date(dateISO + 'T00:00:00').getDay();
    const windows = availability.filter((a) => a.weekday === weekday);
    if (windows.length === 0) continue;

    const allSlots = computeSlots(windows);
    const { data: takenData } = await supabase.rpc('get_taken_slots', { p_doctor_id: doctorId, p_date: dateISO });
    const taken = new Set((takenData ?? []).map((r: { slot_time: string }) => r.slot_time));
    const open = allSlots.find((s) => !taken.has(s));
    if (open) return { date: dateISO, slotTime: open };
  }
  return null;
}

interface RescheduleTarget {
  date: string;
  slotTime: string;
}

const RESCHEDULE_SEARCH_DAYS = 30;

// Walks forward day-by-day from `fromDateISO` (never that same day - this is
// only ever called because the doctor is OUT that day) looking for open
// slots to place `count` displaced appointments into. Spills onto the
// following open day(s) if one day's capacity isn't enough. Returns at most
// `count` targets, in the same order slots were found - the caller is
// expected to hand them out in that same order to a slot-ordered list of
// appointments, so appointment[i] gets targets[i].
async function findRescheduleTargets(doctorId: string, fromDateISO: string, count: number): Promise<RescheduleTarget[]> {
  const { data: availData } = await supabase.from('doctor_availability').select('*').eq('doctor_id', doctorId);
  const availability = (availData ?? []) as DoctorAvailability[];
  const targets: RescheduleTarget[] = [];
  if (availability.length === 0) return targets;

  for (let dayOffset = 1; dayOffset <= RESCHEDULE_SEARCH_DAYS && targets.length < count; dayOffset++) {
    const dateISO = addDaysISO(fromDateISO, dayOffset);
    const weekday = new Date(dateISO + 'T00:00:00').getDay();
    const windows = availability.filter((a) => a.weekday === weekday);
    if (windows.length === 0) continue;

    const allSlots = computeSlots(windows);
    const { data: takenData } = await supabase.rpc('get_taken_slots', { p_doctor_id: doctorId, p_date: dateISO });
    const taken = new Set((takenData ?? []).map((r: { slot_time: string }) => r.slot_time));

    for (const slot of allSlots) {
      if (targets.length >= count) break;
      if (taken.has(slot)) continue;
      targets.push({ date: dateISO, slotTime: slot });
      taken.add(slot); // don't hand the same slot to two displaced appointments in this same batch
    }
  }

  return targets;
}

interface AffectedAppointment {
  id: string;
  status: AppointmentStatus;
  slot_time: string;
  family_members: { account_id: string } | null;
}

export interface FullDayCancelResult {
  rescheduledCount: number;
  unplacedCount: number;
}

// Cancels every still-booked/accepted appointment a doctor has on one date
// and moves each to the next day the doctor is actually available, in slot
// order. Anyone already checked in that day is left alone - if patients have
// physically arrived, the doctor evidently WAS available, so this only makes
// sense for the ones who hadn't turned up yet. No token is involved: a moved
// appointment goes back to holding no number at all, and will draw a fresh
// one when the patient arrives on the new day.
export async function cancelAndRescheduleFullDay(
  doctorId: string,
  fromDateISO: string,
  reason: string
): Promise<FullDayCancelResult> {
  const { data: affectedData } = await supabase
    .from('appointments')
    .select('id, status, slot_time, family_members(account_id)')
    .eq('doctor_id', doctorId)
    .eq('date', fromDateISO)
    .in('status', ['booked', 'accepted'])
    .order('slot_time', { ascending: true });

  const affected = (affectedData ?? []) as unknown as AffectedAppointment[];
  if (affected.length === 0) return { rescheduledCount: 0, unplacedCount: 0 };

  const targets = await findRescheduleTargets(doctorId, fromDateISO, affected.length);

  for (let i = 0; i < targets.length; i++) {
    const appt = affected[i];
    const target = targets[i];

    await supabase
      .from('appointments')
      .update({ date: target.date, slot_time: target.slotTime })
      .eq('id', appt.id);

    const accountId = appt.family_members?.account_id;
    if (accountId) {
      await supabase.from('notifications').insert({
        user_id: accountId,
        appointment_id: appt.id,
        type: 'full_day_reschedule',
        message: `Your appointment on ${fromDateISO} at ${formatTimeLabel(appt.slot_time)} was cancelled: "${reason}". You've been rescheduled to ${target.date} at ${formatTimeLabel(target.slotTime)}.`,
      });
    }
  }

  return { rescheduledCount: targets.length, unplacedCount: affected.length - targets.length };
}
