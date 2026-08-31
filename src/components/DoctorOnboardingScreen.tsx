import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { requiredDocTypesFor } from '../lib/documentTypes';
import { supabase } from '../lib/supabaseClient';
import type { DocumentRow, DoctorStatus } from '../lib/types';
import AgreementConsentForm from './AgreementConsentForm';
import DocumentChecklist from './DocumentChecklist';
import Button from './ui/Button';
import StatusPill from './ui/StatusPill';

interface Props {
  doctorId: string;
  doctorName: string;
  onClose: () => void;
}

const STATUS_TONE: Record<DoctorStatus, 'live' | 'warning' | 'neutral'> = {
  draft: 'neutral',
  pending: 'warning',
  approved: 'live',
  rejected: 'neutral',
};

const STATUS_LABEL: Record<DoctorStatus, string> = {
  draft: 'Draft — onboarding in progress',
  pending: 'Submitted for review',
  approved: 'Approved',
  rejected: 'Rejected',
};

const REQUIRED_DOC_TYPES = requiredDocTypesFor('doctor');

export default function DoctorOnboardingScreen({ doctorId, doctorName, onClose }: Props) {
  const [status, setStatus] = useState<DoctorStatus | null>(null);
  const [hasConsent, setHasConsent] = useState(false);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = async () => {
    const [{ data: doctorData }, { data: consentData }, { data: docData }] = await Promise.all([
      supabase.from('doctors').select('status').eq('id', doctorId).single(),
      supabase.from('consents').select('id').eq('doctor_id', doctorId).limit(1),
      supabase.from('documents').select('*').eq('owner_type', 'doctor').eq('owner_id', doctorId),
    ]);
    setStatus((doctorData?.status as DoctorStatus) ?? null);
    setHasConsent((consentData ?? []).length > 0);
    setDocuments((docData ?? []) as DocumentRow[]);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId]);

  // Mirrors enforce_doctor_submission_requirements() in schema.sql: latest
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
  const canSubmit = hasConsent && missingRequired.length === 0;

  const submitForReview = async () => {
    setSubmitError(null);
    setSubmitting(true);
    const { error } = await supabase.from('doctors').update({ status: 'pending' }).eq('id', doctorId);
    setSubmitting(false);
    if (error) {
      setSubmitError(error.message);
      return;
    }
    await load();
  };

  return (
    <div>
      <div className="flex items-center justify-between border-b border-slate-100 bg-white px-4 py-4">
        <button onClick={onClose} className="inline-flex items-center gap-1 text-sm font-medium text-slate-500">
          <ArrowLeft size={16} /> Back to doctors
        </button>
        {status && <StatusPill label={STATUS_LABEL[status]} tone={STATUS_TONE[status]} />}
      </div>

      <div className="mx-auto max-w-md px-4 py-6">
        <h1 className="text-xl font-bold text-slate-900">{doctorName}</h1>
        <p className="text-sm text-slate-500">Onboarding checklist</p>

        {status === 'pending' && (
          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-brand-50 p-3 text-sm text-brand-800">
            <CheckCircle2 size={18} className="shrink-0" />
            Submitted — waiting on admin review. You can still view the agreement and documents below.
          </div>
        )}
        {(status === 'approved' || status === 'rejected') && (
          <div className="mt-4">
            <StatusPill label={STATUS_LABEL[status]} tone={STATUS_TONE[status]} />
          </div>
        )}

        <div className="mt-5">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">1. Written consent</p>
          <AgreementConsentForm doctorId={doctorId} onSigned={load} />
        </div>

        <div className="mt-5">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">2. Documents</p>
          <DocumentChecklist ownerType="doctor" ownerId={doctorId} onChanged={load} />
        </div>

        {status === 'draft' && (
          <div className="mt-6">
            {!canSubmit && (
              <div className="mb-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
                {!hasConsent && <p>• Agreement not signed yet.</p>}
                {missingRequired.map((t) => (
                  <p key={t.key}>• {t.label} not uploaded yet.</p>
                ))}
              </div>
            )}
            {submitError && <p className="mb-2 text-sm text-red-600">{submitError}</p>}
            <Button onClick={submitForReview} disabled={!canSubmit || submitting} full>
              {submitting ? 'Submitting...' : 'Submit for review'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
