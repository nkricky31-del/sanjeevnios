import { todayISO } from './date';
import { docTypeConfig } from './documentTypes';
import { latestPerType } from './documents';
import { supabase } from './supabaseClient';
import type { DocumentRow, OwnerType, VerificationRequirement } from './types';

// verification_requirements is admin-write, everyone-else-read (schema.sql
// section 49) - the same conditions_ref pattern AdminConditions.tsx already
// uses. This is the one place both the checklist (AdminDocumentReview.tsx)
// and the Approve gate (AdminConsole.tsx) read "is this doc_type mandatory"
// from - neither hardcodes it any more.
export async function loadVerificationRequirements(): Promise<VerificationRequirement[]> {
  const { data } = await supabase
    .from('verification_requirements')
    .select('*')
    .order('owner_type', { ascending: true })
    .order('doc_type', { ascending: true });
  return (data ?? []) as VerificationRequirement[];
}

export function isRequired(requirements: VerificationRequirement[], ownerType: OwnerType, docType: string): boolean {
  return requirements.some((r) => r.owner_type === ownerType && r.doc_type === docType && r.required);
}

// Every reason approval is currently blocked for one owner - mirrors
// is_owner_approval_ready() in schema.sql section 49 exactly (missing / not
// verified yet / rejected / expired), computed from the same documents +
// verification_requirements rows the checklist already has loaded, so the
// disabled Approve button and the reasons shown next to it can never
// disagree with each other, or with what the server actually enforces.
export function approvalBlockers(
  ownerType: OwnerType,
  requirements: VerificationRequirement[],
  documents: DocumentRow[]
): string[] {
  const latest = latestPerType(documents);
  const today = todayISO();
  const reasons: string[] = [];

  for (const req of requirements) {
    if (req.owner_type !== ownerType || !req.required) continue;
    const label = docTypeConfig(req.doc_type)?.label ?? req.doc_type;
    const doc = latest.get(req.doc_type);

    if (!doc) {
      reasons.push(req.doc_type === 'map_location' ? 'Map location not set' : `${label} not uploaded`);
    } else if (doc.status === 'rejected') {
      reasons.push(`${label} rejected`);
    } else if (doc.status === 'pending') {
      reasons.push(`${label} not verified yet`);
    } else if (doc.expiry_date && doc.expiry_date < today) {
      reasons.push(`${label} has expired`);
    }
  }

  return reasons;
}

export function isApprovalReady(
  ownerType: OwnerType,
  requirements: VerificationRequirement[],
  documents: DocumentRow[]
): boolean {
  return approvalBlockers(ownerType, requirements, documents).length === 0;
}
