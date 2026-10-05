import { supabase } from './supabaseClient';

// What the front desk is allowed to know about a patient (migration 68, now
// the get_patient_contacts() function from migration 76): enough to greet, call and contact them - age, never
// the date of birth, and nothing clinical. Clinic screens read this instead
// of family_members, which clinic staff can no longer read directly without
// an audited health-record grant.
export interface PatientContact {
  id: string;
  name: string;
  relation: string | null;
  account_id: string;
  phone: string | null;
  gender: string | null;
  age: number | null;
  mrn: string;
}

// Attaches each row's patient (looked up by member_id) under
// `family_members`, the key the clinic screens already read - one extra
// query for the whole batch, not one per row.
export async function withPatientContacts<T extends { member_id: string }>(
  rows: T[]
): Promise<(T & { family_members: PatientContact | null })[]> {
  const ids = [...new Set(rows.map((r) => r.member_id))];
  if (ids.length === 0) return rows.map((r) => ({ ...r, family_members: null }));
  const { data } = await supabase.rpc('get_patient_contacts', { p_ids: ids });
  const byId = new Map(((data ?? []) as PatientContact[]).map((p) => [p.id, p]));
  return rows.map((r) => ({ ...r, family_members: byId.get(r.member_id) ?? null }));
}

// "34y · female · +919876543210" - the quick context line under a name.
export function patientContextLine(p: Pick<PatientContact, 'age' | 'gender' | 'phone'> | null): string | null {
  if (!p) return null;
  const parts: string[] = [];
  if (p.age != null) parts.push(`${p.age}y`);
  if (p.gender) parts.push(p.gender);
  if (p.phone) parts.push(`+${p.phone}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
