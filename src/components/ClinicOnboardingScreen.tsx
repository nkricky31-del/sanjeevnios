import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { requiredDocTypesFor } from '../lib/documentTypes';
import { supabase } from '../lib/supabaseClient';
import type { Clinic, ClinicStatus, DocumentRow } from '../lib/types';
import ClinicLocationPicker from './ClinicLocationPicker';
import DocumentChecklist from './DocumentChecklist';
import Button from './ui/Button';
import StatusPill from './ui/StatusPill';

interface Props {
  clinic: Clinic;
  onClinicSaved: (patch: Partial<Clinic>) => void;
}

const STATUS_TONE: Record<ClinicStatus, 'live' | 'warning' | 'neutral'> = {
  draft: 'neutral',
  pending: 'warning',
  approved: 'live',
  rejected: 'neutral',
};

const STATUS_LABEL: Record<ClinicStatus, string> = {
  draft: 'Draft — onboarding in progress',
  pending: 'Submitted for review',
  approved: 'Approved',
  rejected: 'Rejected',
};

const REQUIRED_DOC_TYPES = requiredDocTypesFor('clinic');

// Mirrors DoctorOnboardingScreen.tsx exactly, one level up: the clinic's own
// map location + document checklist, gated behind the same
// draft -> pending "Submit for review" rule enforce_clinic_submission_requirements()
// (schema.sql section 45) enforces server-side. Rendered from ClinicDoctors.tsx,
// which is where a clinic already manages everything else about its own
// onboarding (adding doctors, their own onboarding screens).
export default function ClinicOnboardingScreen({ clinic, onClinicSaved }: Props) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = async () => {
    const { data } = await supabase.from('documents').select('*').eq('owner_type', 'clinic').eq('owner_id', clinic.id);
    setDocuments((data ?? []) as DocumentRow[]);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinic.id]);

  // Mirrors enforce_clinic_submission_requirements() in schema.sql: latest
  // upload per required doc_type must exist and not be rejected. This is
  // just the UX pre-check - the trigger is what actually can't be bypassed.
  const latestByType = new Map<string, DocumentRow>();
  for (const d of [...documents].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    latestByType.set(d.doc_type, d);
  }
  const missingRequired = REQUIRED_DOC_TYPES.filter((t) => {
    const latest = latestByType.get(t.key);
    return !latest || latest.status === 'rejected';
  });
  const canSubmit = missingRequired.length === 0;

  const submitForReview = async () => {
    setSubmitError(null);
    setSubmitting(true);
    const { error } = await supabase.from('clinics').update({ status: 'pending' }).eq('id', clinic.id);
    setSubmitting(false);
    if (error) {
      setSubmitError(error.message);
      return;
    }
    onClinicSaved({ status: 'pending' });
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Clinic onboarding</h2>
        <StatusPill label={STATUS_LABEL[clinic.status]} tone={STATUS_TONE[clinic.status]} />
      </div>

      {clinic.status === 'pending' && (
        <div className="mt-3 flex items-center gap-2 rounded-2xl bg-brand-50 p-3 text-sm text-brand-800">
          <CheckCircle2 size={18} className="shrink-0" />
          Submitted — waiting on admin review. You can still view your documents and location below.
        </div>
      )}
      {clinic.status === 'rejected' && clinic.reject_reason && (
        <p className="mt-2 text-sm font-medium text-red-600">Reason: {clinic.reject_reason}</p>
      )}

      <div className="mt-5">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">1. Map location</p>
        <ClinicLocationPicker
          clinicId={clinic.id}
          initialLat={clinic.lat}
          initialLng={clinic.lng}
          initialAddress={clinic.formatted_address}
          onSaved={(lat, lng, formattedAddress) => onClinicSaved({ lat, lng, formatted_address: formattedAddress })}
        />
      </div>

      <div className="mt-5">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">2. Documents</p>
        <DocumentChecklist ownerType="clinic" ownerId={clinic.id} onChanged={load} />
      </div>

      {clinic.status === 'draft' && (
        <div className="mt-6">
          {!canSubmit && (
            <div className="mb-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
              {missingRequired.map((t) => (
                <p key={t.key}>• {t.label} not uploaded yet.</p>
              ))}
            </div>
          )}
          {submitError && <p className="mb-2 text-sm text-red-600">{submitError}</p>}
          <Button onClick={submitForReview} disabled={!canSubmit || submitting} full>
            {submitting ? 'Submitting...' : 'Submit clinic for review'}
          </Button>
        </div>
      )}
    </div>
  );
}
