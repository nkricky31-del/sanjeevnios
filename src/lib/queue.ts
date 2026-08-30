import { addDaysISO } from './date';
import { supabase } from './supabaseClient';
import { computeSlots, formatTimeLabel } from './time';
import type { AppointmentStatus, DoctorAvailability, QueueStatusRow } from './types';

export function computeNowServing(dayQueue: QueueStatusRow[]): number | null {
  const active = dayQueue.filter((r) => ['accepted', 'in_progress', 'done'].includes(r.status));
  if (active.length === 0) return null;

  const inProgress = active.find((r) => r.status === 'in_progress');
  if (inProgress) return inProgress.token_no;

  const doneTokens = active.filter((r) => r.status === 'done').map((r) => r.token_no);
  if (doneTokens.length > 0) return Math.max(...doneTokens) + 1;

  return Math.min(...active.map((r) => r.token_no));
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
// expected to hand them out in that same order to a token-ordered list of
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
  token_no: number | null;
  slot_time: string;
  family_members: { account_id: string } | null;
}

export interface FullDayCancelResult {
  rescheduledCount: number;
  unplacedCount: number;
}

// Cancels every still-pending/accepted appointment a doctor has on one date
// and moves each to the next day the doctor is actually available, in
// token order (accepted bookings keep their relative order but get a fresh
// token on the new day; pending ones just move date/slot and stay pending).
// Appointments already in_progress/done/etc. that day are left alone - if
// one of those exists the doctor clearly WAS available, so this only makes
// sense for the ones that hadn't been seen yet.
export async function cancelAndRescheduleFullDay(
  doctorId: string,
  fromDateISO: string,
  reason: string
): Promise<FullDayCancelResult> {
  const { data: affectedData } = await supabase
    .from('appointments')
    .select('id, status, token_no, slot_time, family_members(account_id)')
    .eq('doctor_id', doctorId)
    .eq('date', fromDateISO)
    .in('status', ['pending', 'accepted'])
    .order('token_no', { ascending: true, nullsFirst: false })
    .order('slot_time', { ascending: true });

  const affected = (affectedData ?? []) as unknown as AffectedAppointment[];
  if (affected.length === 0) return { rescheduledCount: 0, unplacedCount: 0 };

  const targets = await findRescheduleTargets(doctorId, fromDateISO, affected.length);
  const nextTokenByDate = new Map<string, number>();

  for (let i = 0; i < targets.length; i++) {
    const appt = affected[i];
    const target = targets[i];

    let newToken: number | null = null;
    if (appt.status === 'accepted') {
      if (!nextTokenByDate.has(target.date)) {
        const { data: maxRow } = await supabase
          .from('appointments')
          .select('token_no')
          .eq('doctor_id', doctorId)
          .eq('date', target.date)
          .not('status', 'in', '(pending,rejected,cancelled)')
          .order('token_no', { ascending: false })
          .limit(1)
          .maybeSingle();
        nextTokenByDate.set(target.date, (maxRow?.token_no ?? 0) + 1);
      }
      newToken = nextTokenByDate.get(target.date) ?? 1;
      nextTokenByDate.set(target.date, newToken + 1);
    }

    await supabase
      .from('appointments')
      .update({ date: target.date, slot_time: target.slotTime, token_no: newToken })
      .eq('id', appt.id);

    const accountId = appt.family_members?.account_id;
    if (accountId) {
      const tokenNote = newToken != null ? ` Your new token is #${newToken}.` : '';
      await supabase.from('notifications').insert({
        user_id: accountId,
        appointment_id: appt.id,
        type: 'full_day_reschedule',
        message: `Your appointment on ${fromDateISO} at ${formatTimeLabel(appt.slot_time)} was cancelled: "${reason}". You've been rescheduled to ${target.date} at ${formatTimeLabel(target.slotTime)}.${tokenNote}`,
      });
    }
  }

  return { rescheduledCount: targets.length, unplacedCount: affected.length - targets.length };
}
