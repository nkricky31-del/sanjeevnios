import { supabase } from './supabaseClient';

export const APPOINTMENT_FILES_BUCKET = 'appointment-files';
export const VERIFICATION_DOCS_BUCKET = 'verification-docs';
export const PATIENT_PHOTOS_BUCKET = 'patient-photos';
export const ID_DOCUMENTS_BUCKET = 'id-documents';

// The bucket is private, so there's no plain URL to link to - this asks
// Storage for a short-lived signed link and opens it immediately.
export async function openAppointmentFile(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(APPOINTMENT_FILES_BUCKET).createSignedUrl(path, 60);
  if (error || !data) return null;
  window.open(data.signedUrl, '_blank', 'noopener');
  return data.signedUrl;
}

// Same idea, for a clinic/doctor's uploaded registration document - used by
// the admin verification console.
export async function openVerificationDoc(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(VERIFICATION_DOCS_BUCKET).createSignedUrl(path, 60);
  if (error || !data) return null;
  window.open(data.signedUrl, '_blank', 'noopener');
  return data.signedUrl;
}

// The government ID uploaded with a name-change request - only the
// uploading patient and an admin can ever generate a signed link to it (see
// migration_53's id_documents_select policy).
export async function openIdDocument(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(ID_DOCUMENTS_BUCKET).createSignedUrl(path, 60);
  if (error || !data) return null;
  window.open(data.signedUrl, '_blank', 'noopener');
  return data.signedUrl;
}

// A patient photo is drawn straight into an <img>, not opened in a new tab -
// this just hands back the short-lived signed URL. null means "no photo, or
// the viewer isn't allowed to see it" - callers fall back to an initials
// avatar either way, so there's nothing to distinguish.
export async function patientPhotoUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(PATIENT_PHOTOS_BUCKET).createSignedUrl(path, 300);
  if (error || !data) return null;
  return data.signedUrl;
}
