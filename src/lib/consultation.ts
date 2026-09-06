import { supabase } from './supabaseClient';

export interface DoctorConsultationStats {
  avgMinutes: number | null;
  sampleSize: number;
}

// get_doctor_avg_consultation_minutes() (schema.sql section 54) - an
// aggregate only, so this is safe to call from either the clinic's own queue
// screen or a patient's booking status page: it never exposes another
// patient's individual visit. avgMinutes is null until this doctor has at
// least one completed, non-flagged visit.
export async function getDoctorConsultationStats(doctorId: string): Promise<DoctorConsultationStats> {
  const { data, error } = await supabase.rpc('get_doctor_avg_consultation_minutes', { p_doctor_id: doctorId });
  const row = (data ?? [])[0] as { avg_minutes: number | null; sample_size: number } | undefined;
  if (error || !row) return { avgMinutes: null, sampleSize: 0 };
  return { avgMinutes: row.avg_minutes, sampleSize: row.sample_size };
}
