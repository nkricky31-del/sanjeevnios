import { useEffect, useState } from 'react';

import AddDoctorForm from '../components/AddDoctorForm';
import ClinicOnboardingScreen from '../components/ClinicOnboardingScreen';
import DoctorAvailabilityForm from '../components/DoctorAvailabilityForm';
import DoctorOnboardingScreen from '../components/DoctorOnboardingScreen';
import Card from '../components/ui/Card';
import StatusPill from '../components/ui/StatusPill';
import { supabase } from '../lib/supabaseClient';
import type { Clinic, Doctor, DoctorStatus } from '../lib/types';

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

export default function ClinicDoctors({ clinic, onClinicSaved }: Props) {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedDoctorId, setExpandedDoctorId] = useState<string | null>(null);
  const [onboardingDoctor, setOnboardingDoctor] = useState<{ id: string; name: string } | null>(null);

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

  useEffect(() => {
    loadDoctors();
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

  return (
    <div>
      <ClinicOnboardingScreen clinic={clinic} onClinicSaved={onClinicSaved} />

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Doctors</h2>
        <button onClick={() => setShowAddForm((s) => !s)} className="text-sm font-semibold text-brand-600">
          {showAddForm ? 'Cancel' : '+ Add doctor'}
        </button>
      </div>

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
          <p className="text-sm text-slate-400">No doctors added yet.</p>
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
              <StatusPill label={STATUS_LABEL[d.status]} tone={STATUS_TONE[d.status]} />
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
            </div>

            {expandedDoctorId === d.id && <DoctorAvailabilityForm doctorId={d.id} />}
          </Card>
        ))}
      </div>
    </div>
  );
}
