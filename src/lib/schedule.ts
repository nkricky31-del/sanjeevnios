import { supabase } from './supabaseClient';
import type { DayScheduleRow } from './types';

// ---------------------------------------------------------------------------
// Publishing (schema.sql section 34)
// ---------------------------------------------------------------------------
// This is the night-before batch: for every booked patient on a day, assign
// a sequence number and an estimated time, and notify them. It never checks
// anyone in and never touches token_number - see check_in_appointment() for
// the actual arrival token, which is a separate thing entirely.

export async function previewDaySchedule(clinicId: string, dateISO: string): Promise<DayScheduleRow[]> {
  const { data, error } = await supabase.rpc('preview_day_schedule', {
    p_clinic_id: clinicId,
    p_date: dateISO,
  });
  if (error) return [];
  return (data ?? []) as DayScheduleRow[];
}

export interface PublishedRow {
  appointmentId: string;
  seq: number;
  estimatedTime: string;
  memberName: string;
  encounterNo: string | null;
  doctorName: string;
}

export async function publishDaySchedule(
  clinicId: string,
  dateISO: string
): Promise<{ rows: PublishedRow[] } | { error: string }> {
  const { data, error } = await supabase.rpc('publish_day_schedule', {
    p_clinic_id: clinicId,
    p_date: dateISO,
  });
  if (error) return { error: error.message };
  const rows = (
    (data ?? []) as {
      appointment_id: string;
      seq: number;
      estimated_time: string;
      member_name: string;
      encounter_no: string | null;
      doctor_name: string;
    }[]
  ).map((r) => ({
    appointmentId: r.appointment_id,
    seq: r.seq,
    estimatedTime: r.estimated_time,
    memberName: r.member_name,
    encounterNo: r.encounter_no,
    doctorName: r.doctor_name,
  }));
  return { rows };
}

// ---------------------------------------------------------------------------
// Manual reorder, before or after publishing
// ---------------------------------------------------------------------------
// day_order_override is a plain rank (schema.sql 34.2). preview_day_schedule
// already hands back each row's current effective rank as `seq` - a clean
// run of consecutive integers - so moving a row past its neighbour just
// needs a value half a step beyond that neighbour's seq. Because `seq` is
// always freshly recomputed (never the override value itself), this stays
// exact no matter how many times a row gets moved - there's no repeated
// bisection to lose precision over. Appointments RLS already lets the
// owning clinic write this column directly, so no RPC is needed.
export async function moveInDaySchedule(
  appointmentId: string,
  neighborSeq: number,
  direction: 'up' | 'down'
): Promise<{ error?: string }> {
  const target = direction === 'up' ? neighborSeq - 0.5 : neighborSeq + 0.5;
  const { error } = await supabase
    .from('appointments')
    .update({ day_order_override: target })
    .eq('id', appointmentId);
  return error ? { error: error.message } : {};
}

export async function clearReorder(appointmentId: string): Promise<{ error?: string }> {
  const { error } = await supabase
    .from('appointments')
    .update({ day_order_override: null })
    .eq('id', appointmentId);
  return error ? { error: error.message } : {};
}

// ---------------------------------------------------------------------------
// Breaks (direct table access - clinic_schedule_breaks RLS already scopes
// this to the owning clinic, same pattern as clinic_holidays)
// ---------------------------------------------------------------------------

export async function addScheduleBreak(
  clinicId: string,
  dateISO: string,
  beforeSeq: number,
  minutes: number,
  label: string
): Promise<{ error?: string }> {
  const { error } = await supabase.from('clinic_schedule_breaks').insert({
    clinic_id: clinicId,
    date: dateISO,
    before_seq: beforeSeq,
    minutes,
    label: label || null,
  });
  return error ? { error: error.message } : {};
}

export async function removeScheduleBreak(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.from('clinic_schedule_breaks').delete().eq('id', id);
  return error ? { error: error.message } : {};
}
