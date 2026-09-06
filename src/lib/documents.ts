import { VERIFICATION_DOCS_BUCKET } from './storage';
import { supabase } from './supabaseClient';
import type { DocumentRow, OwnerType } from './types';

export const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10MB - matches the bucket's server-side limit
export const ALLOWED_DOC_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

// Validates, uploads to the private verification-docs bucket, then inserts
// the documents row - the one path every "upload a verification document"
// screen goes through: DocumentChecklist.tsx's per-type checklist, and
// ClinicSignup.tsx's single-certificate quick-start step (schema.sql
// section 48). Always a fresh INSERT, never an UPDATE - see the `documents`
// table's own comment in schema.sql for why a re-upload after rejection
// works the same way.
export async function uploadVerificationDocument(args: {
  ownerType: OwnerType;
  ownerId: string;
  docType: string;
  file: File;
  number?: string | null;
  expiryDate?: string | null;
}): Promise<{ error: string | null }> {
  const { ownerType, ownerId, docType, file, number, expiryDate } = args;

  if (!ALLOWED_DOC_TYPES.includes(file.type)) {
    return { error: 'File must be a JPG, PNG, or PDF.' };
  }
  if (file.size > MAX_DOC_BYTES) {
    return { error: 'File must be under 10MB.' };
  }

  const path = `${ownerType}s/${ownerId}/${docType}/${crypto.randomUUID()}-${file.name}`;
  const { error: uploadError } = await supabase.storage
    .from(VERIFICATION_DOCS_BUCKET)
    .upload(path, file, { contentType: file.type });
  if (uploadError) return { error: uploadError.message };

  const { error: insertError } = await supabase.from('documents').insert({
    owner_type: ownerType,
    owner_id: ownerId,
    doc_type: docType,
    storage_path: path,
    number: number || null,
    expiry_date: expiryDate || null,
    status: 'pending',
  });
  if (insertError) return { error: insertError.message };

  return { error: null };
}

// Reduces a list of document rows (there can be several per doc_type, from
// re-uploads after a rejection) down to just the most recent row per
// doc_type - the "latest row wins" pattern used throughout the
// onboarding/documents feature (see documents table comment in schema.sql).
export function latestPerType(documents: DocumentRow[]): Map<string, DocumentRow> {
  const sorted = [...documents].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const map = new Map<string, DocumentRow>();
  for (const d of sorted) map.set(d.doc_type, d); // later rows overwrite earlier ones
  return map;
}
