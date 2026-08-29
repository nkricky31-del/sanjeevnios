import { supabase } from './supabaseClient';

export const APPOINTMENT_FILES_BUCKET = 'appointment-files';

// The bucket is private, so there's no plain URL to link to - this asks
// Storage for a short-lived signed link and opens it immediately.
export async function openAppointmentFile(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(APPOINTMENT_FILES_BUCKET).createSignedUrl(path, 60);
  if (error || !data) return null;
  window.open(data.signedUrl, '_blank', 'noopener');
  return data.signedUrl;
}
