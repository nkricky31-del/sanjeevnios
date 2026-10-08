import { supabase } from './supabaseClient';

export const APPOINTMENT_FILES_BUCKET = 'appointment-files';
export const VERIFICATION_DOCS_BUCKET = 'verification-docs';
export const PATIENT_PHOTOS_BUCKET = 'patient-photos';
export const ID_DOCUMENTS_BUCKET = 'id-documents';

// The bucket is private, so there's no plain URL to link to. A download is
// its own permission (patient.health.download, migration 68): the server
// checks it for this login and file, writes the audit entry, and only then
// lets Storage sign a short-lived link - which it opens immediately.
export async function openAppointmentFile(fileId: string): Promise<{ url: string } | { error: string }> {
  const { data: path, error: authError } = await supabase.rpc('authorize_patient_file_download', { p_file_id: fileId });
  if (authError || !path) return { error: authError?.message ?? 'Could not open file.' };
  const { data, error } = await supabase.storage.from(APPOINTMENT_FILES_BUCKET).createSignedUrl(path as string, 60);
  if (error || !data) return { error: 'Could not open file.' };
  window.open(data.signedUrl, '_blank', 'noopener');
  return { url: data.signedUrl };
}

// Same permission check as above, but saves the file to the device instead of
// opening a tab.
export async function downloadAppointmentFile(fileId: string): Promise<{ ok: true } | { error: string }> {
  const { data: path, error: authError } = await supabase.rpc('authorize_patient_file_download', { p_file_id: fileId });
  if (authError || !path) return { error: authError?.message ?? 'Could not download file.' };
  const { data, error } = await supabase.storage
    .from(APPOINTMENT_FILES_BUCKET)
    .createSignedUrl(path as string, 60, { download: (path as string).split('/').pop() ?? true });
  if (error || !data) return { error: 'Could not download file.' };
  const a = document.createElement('a');
  a.href = data.signedUrl;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return { ok: true };
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
