import type { DocumentRow } from './types';

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

// True if, among the latest upload per doc_type, at least one is currently
// rejected - i.e. there's an outstanding issue that hasn't been resolved
// with a fresh upload yet. A doc_type that was once rejected but has since
// been re-uploaded (and is now pending/verified) does NOT count.
export function hasUnresolvedRejection(documents: DocumentRow[]): boolean {
  return Array.from(latestPerType(documents).values()).some((d) => d.status === 'rejected');
}
