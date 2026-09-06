import { useEffect, useState } from 'react';

import { docTypesFor } from '../lib/documentTypes';
import { supabase } from '../lib/supabaseClient';
import type { OwnerType, VerificationRequirement } from '../lib/types';
import StatusPill from './ui/StatusPill';

const OWNER_LABEL: Record<OwnerType, string> = { clinic: 'Clinic', doctor: 'Doctor' };

// verification_requirements is admin-write, everyone-else-read (schema.sql
// section 49) - the "admin controls the required list" screen the spec asks
// for, same conditions_ref/AdminConditions.tsx pattern: no add/remove, just
// toggle the flag on a fixed set of rows (one per doc_type in
// documentTypes.ts, seeded by the migration).
export default function AdminVerificationRequirements() {
  const [requirements, setRequirements] = useState<VerificationRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('verification_requirements')
      .select('*')
      .order('owner_type', { ascending: true })
      .order('doc_type', { ascending: true });
    setRequirements((data ?? []) as VerificationRequirement[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const toggle = async (r: VerificationRequirement) => {
    setError(null);
    const { error: updateError } = await supabase
      .from('verification_requirements')
      .update({ required: !r.required })
      .eq('id', r.id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    load();
  };

  const requirementFor = (ownerType: OwnerType, docType: string) =>
    requirements.find((r) => r.owner_type === ownerType && r.doc_type === docType);

  return (
    <div>
      <h2 className="text-lg font-bold text-slate-900">Approval requirements</h2>
      <p className="mt-0.5 text-xs text-slate-400">
        Only items marked Required here block the Approve button - a clinic or doctor must have every one of these
        uploaded and verified (not just uploaded) before an admin can approve them. Everything else stays optional.
      </p>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {loading && <p className="mt-3 text-sm text-slate-400">Loading...</p>}

      {(['clinic', 'doctor'] as OwnerType[]).map((ownerType) => (
        <div key={ownerType} className="mt-4">
          <p className="text-sm font-bold text-slate-700">{OWNER_LABEL[ownerType]} items</p>
          <div className="mt-2 space-y-2">
            {docTypesFor(ownerType).map((config) => {
              const req = requirementFor(ownerType, config.key);
              const required = req?.required ?? false;
              return (
                <div
                  key={config.key}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">{config.label}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-400">{config.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusPill label={required ? 'Required' : 'Optional'} tone={required ? 'warning' : 'neutral'} />
                    <button
                      onClick={() => req && toggle(req)}
                      disabled={!req}
                      className="text-xs font-bold text-brand-600 disabled:opacity-40"
                    >
                      {required ? 'Make optional' : 'Make required'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
