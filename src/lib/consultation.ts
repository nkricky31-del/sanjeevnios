import { supabase } from './supabaseClient';

export interface DoctorConsultationStats {
  avgMinutes: number | null;
  sampleSize: number;
}

// An average over many visits barely moves from one visit to the next, and
// every queue screen asks for it whenever the queue moves - so one answer per
// doctor is reused for a minute, and simultaneous asks share one request.
const CACHE_MS = 60_000;
interface CacheEntry {
  at: number;
  value: Promise<DoctorConsultationStats>;
}
const cache = new Map<string, CacheEntry>();

async function fetchStats(doctorId: string): Promise<DoctorConsultationStats | null> {
  const { data, error } = await supabase.rpc('get_doctor_avg_consultation_minutes', { p_doctor_id: doctorId });
  const row = (data ?? [])[0] as { avg_minutes: number | null; sample_size: number } | undefined;
  if (error || !row) return null;
  return { avgMinutes: row.avg_minutes, sampleSize: row.sample_size };
}

// get_doctor_avg_consultation_minutes() (schema.sql section 54; the latest
// 200 timed visits since migration 87) - an aggregate only, so this is safe
// to call from either the clinic's own queue screen or a patient's booking
// status page: it never exposes another patient's individual visit.
// avgMinutes is null until this doctor has at least one completed,
// non-flagged visit.
export function getDoctorConsultationStats(doctorId: string): Promise<DoctorConsultationStats> {
  const hit = cache.get(doctorId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const entry: CacheEntry = {
    at: Date.now(),
    value: fetchStats(doctorId).then((stats) => {
      if (stats) return stats;
      // Don't hold on to a failure - the next ask tries again.
      if (cache.get(doctorId) === entry) cache.delete(doctorId);
      return { avgMinutes: null, sampleSize: 0 };
    }),
  };
  cache.set(doctorId, entry);
  return entry.value;
}
