import { useEffect, useState } from 'react';

import AddDoctorForm from '../components/AddDoctorForm';
import ClinicOnboardingScreen from '../components/ClinicOnboardingScreen';
import DoctorAvailabilityForm from '../components/DoctorAvailabilityForm';
import DoctorOnboardingScreen from '../components/DoctorOnboardingScreen';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import StatusPill from '../components/ui/StatusPill';
import { requiredDocTypesFor } from '../lib/documentTypes';
import { supabase } from '../lib/supabaseClient';
import type { Clinic, Doctor, DocumentRow, DoctorStatus } from '../lib/types';

interface Props {
  clinic: Clinic;
  onClinicSaved: (patch: Partial<Clinic>) => void;
}

const STATUS_TONE: Record<DoctorStatus, 'live' | 'warning' | 'neutral'> = {
  draft: 'neutral',
  pending: 'warning',
  approved: 'live',
  rejected: 'neutral',
};

const STATUS_LABEL: Record<DoctorStatus, string> = {
  draft: 'Onboarding in progress',
  pending: 'Submitted for review',
  approved: 'Approved',
  rejected: 'Rejected',
};

const REQUIRED_CLINIC_DOC_TYPES = requiredDocTypesFor('clinic');

// The single clinic registration page (section 55, tightening sections
// 45/48/49): the clinic's own details (map location + documents, rendered by
// ClinicOnboardingScreen) and the doctor block (add doctor -> that doctor's
// own onboarding checklist) live together here, and "Send for verification"
// at the bottom is gated on BOTH - mirroring
// enforce_clinic_submission_requirements() (schema.sql section 55) exactly,
// which is the version of this rule that can't be bypassed by calling the
// API directly.
export default function ClinicDoctors({ clinic, onClinicSaved }: Props) {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedDoctorId, setExpandedDoctorId] = useState<string | null>(null);
  const [onboardingDoctor, setOnboardingDoctor] = useState<{ id: string; name: string } | null>(null);
  const [clinicDocuments, setClinicDocuments] = useState<DocumentRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [togglingActiveFor, setTogglingActiveFor] = useState<string | null>(null);

  const loadDoctors = async () => {
    setLoading(true);
    // The clinic owner sees ALL of its own doctors regardless of status
    // (RLS: is_own_clinic) - only the public/patient branch of doctors_select
    // is restricted to status = 'approved'.
    const { data } = await supabase
      .from('doctors')
      .select('*')
      .eq('clinic_id', clinic.id)
      .order('created_at', { ascending: true });
    setDoctors(data ?? []);
    setLoading(false);
  };

  const loadClinicDocuments = async () => {
    const { data } = await supabase
      .from('documents')
      .select('*')
      .eq('owner_type', 'clinic')
      .eq('owner_id', clinic.id);
    setClinicDocuments((data ?? []) as DocumentRow[]);
  };

  useEffect(() => {
    loadDoctors();
    loadClinicDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinic.id]);

  if (onboardingDoctor) {
    return (
      <DoctorOnboardingScreen
        doctorId={onboardingDoctor.id}
        doctorName={onboardingDoctor.name}
        onClose={() => {
          setOnboardingDoctor(null);
          loadDoctors();
        }}
      />
    );
  }

  // Mirrors enforce_clinic_submission_requirements() in schema.sql (section
  // 55): latest upload per required clinic doc_type must exist and not be
  // rejected, the map pin must be placed, and at least one doctor must have
  // reached 'pending' or 'approved' itself (which it can only do having
  // already cleared its OWN required-document gate). This is just the UX
  // pre-check - the trigger is what actually can't be bypassed.
  const latestByType = new Map<string, DocumentRow>();
  for (const d of [...clinicDocuments].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    latestByType.set(d.doc_type, d);
  }
  const missingClinicDocs = REQUIRED_CLINIC_DOC_TYPES.filter((t) => {
    const latest = latestByType.get(t.key);
    return !latest || latest.status === 'rejected';
  });
  const hasMapLocation = clinic.lat != null && clinic.lng != null;
  const hasReadyDoctor = doctors.some((d) => d.status === 'pending' || d.status === 'approved');
  const canSubmit = missingClinicDocs.length === 0 && hasMapLocation && hasReadyDoctor;

  // The clinic's own "this doctor no longer works here" / "they're back"
  // lever (migration 62's doctors.is_active) - the only way to free up a
  // slot on the current plan short of an admin rejecting the doctor
  // outright. Deactivating never lowers the bill until the next billing
  // cycle (razorpay-webhook's own downgrade check); reactivating can raise
  // it immediately if it pushes the clinic back over its plan
  // (reassign_clinic_plan_for_doctor_count(), the same trigger a brand-new
  // approval goes through) - the best-effort sync call after either
  // direction is harmless when nothing actually needs to change.
  const toggleDoctorActive = async (d: Doctor) => {
    setTogglingActiveFor(d.id);
    const { error } = await supabase.from('doctors').update({ is_active: !d.is_active }).eq('id', d.id);
    setTogglingActiveFor(null);
    if (error) {
      setSubmitError(error.message);
      return;
    }
    loadDoctors();
    supabase.functions.invoke('sync-razorpay-subscription-plan', { body: { clinicId: clinic.id } }).catch((err) => {
      console.error('sync-razorpay-subscription-plan failed:', err);
    });
  };

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
      <ClinicOnboardingScreen clinic={clinic} onClinicSaved={onClinicSaved} onDocumentsChanged={loadClinicDocuments} />

      <div className="mt-6 flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">3. Doctors</p>
        <button onClick={() => setShowAddForm((s) => !s)} className="text-sm font-semibold text-brand-600">
          {showAddForm ? 'Cancel' : '+ Add doctor'}
        </button>
      </div>
      <h2 className="text-lg font-bold text-slate-900">Doctors</h2>
      <p className="text-xs text-slate-500">
        At least one doctor with every required document submitted is needed before the clinic can be sent for
        verification.
      </p>

      {showAddForm && (
        <AddDoctorForm
          clinicId={clinic.id}
          onAdded={(doctorId) => {
            setShowAddForm(false);
            loadDoctors();
            setOnboardingDoctor({ id: doctorId, name: 'New doctor' });
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <div className="mt-3 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && doctors.length === 0 && (
          <p className="text-sm text-slate-400">No doctors added yet. Add another doctor to continue.</p>
        )}
        {doctors.map((d) => (
          <Card key={d.id}>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-slate-900">{d.name}</p>
                {d.specialty && <p className="text-sm text-brand-600">{d.specialty}</p>}
                <p className="text-xs text-slate-400">
                  Reg. {d.reg_no ?? '—'} · ₹{d.consultation_fee} / visit
                </p>
                {d.status === 'rejected' && d.reject_reason && (
                  <p className="mt-1 text-xs font-medium text-red-600">Reason: {d.reject_reason}</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                <StatusPill label={STATUS_LABEL[d.status]} tone={STATUS_TONE[d.status]} />
                {d.status === 'approved' && !d.is_active && <StatusPill label="Inactive" tone="neutral" />}
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-3">
              <button
                onClick={() => setOnboardingDoctor({ id: d.id, name: d.name })}
                className="text-sm font-medium text-brand-600"
              >
                {d.status === 'draft' ? 'Continue onboarding' : 'View onboarding'}
              </button>
              <button
                onClick={() => setExpandedDoctorId((prev) => (prev === d.id ? null : d.id))}
                className="text-sm font-medium text-brand-600"
              >
                {expandedDoctorId === d.id ? 'Hide availability' : 'Manage availability'}
              </button>
              {d.status === 'approved' && (
                <button
                  onClick={() => toggleDoctorActive(d)}
                  disabled={togglingActiveFor === d.id}
                  className={`text-sm font-medium ${d.is_active ? 'text-red-600' : 'text-emerald-600'}`}
                >
                  {togglingActiveFor === d.id ? 'Saving...' : d.is_active ? 'Remove from clinic' : 'Restore to clinic'}
                </button>
              )}
            </div>
            {d.status === 'approved' && !d.is_active && (
              <p className="mt-1.5 text-xs text-slate-400">
                No longer counted toward your plan or shown in patient search. Won't lower your bill until your next
                billing cycle.
              </p>
            )}

            {expandedDoctorId === d.id && <DoctorAvailabilityForm doctorId={d.id} />}
          </Card>
        ))}
      </div>

      {clinic.status === 'draft' && (
        <div className="mt-6">
          {!canSubmit && (
            <div className="mb-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
              {missingClinicDocs.map((t) => (
                <p key={t.key}>• {t.label} not uploaded yet.</p>
              ))}
              {!hasMapLocation && <p>• Map location not set yet.</p>}
              {!hasReadyDoctor && <p>• Add at least one doctor and submit them for review (all their required documents).</p>}
            </div>
          )}
          {submitError && <p className="mb-2 text-sm text-red-600">{submitError}</p>}
          <Button onClick={submitForReview} disabled={!canSubmit || submitting} full>
            {submitting ? 'Sending...' : 'Send for verification'}
          </Button>
        </div>
      )}
    </div>
  );
}
