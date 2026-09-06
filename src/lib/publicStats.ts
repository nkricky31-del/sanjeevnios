import { supabase } from './supabaseClient';

// Mirrors get_public_stats()'s return row (schema.sql section 56) - every
// field is an aggregate count, safe to show to a logged-out visitor.
export interface PublicStats {
  clinics_onboarded: number;
  clinics_live: number;
  patients_served: number;
  doctors_onboarded: number;
  cities_covered: number;
  computed_at: string;
}

// Called with no session from the public marketing site (LiveStats.tsx) -
// get_public_stats() is grant-execute'd to `anon` specifically for this.
// The 5-minute server-side cache (same function) means repeat calls from
// many visitors within that window just read one cached row - this helper
// itself does no client-side caching beyond that.
export async function fetchPublicStats(): Promise<PublicStats | null> {
  const { data, error } = await supabase.rpc('get_public_stats').single();
  if (error || !data) return null;
  return data as PublicStats;
}
