import { CheckCircle2 } from 'lucide-react';

import type { Clinic, ClinicStatus } from '../lib/types';
import ClinicLocationPicker from './ClinicLocationPicker';
import DocumentChecklist from './DocumentChecklist';
import StatusPill from './ui/StatusPill';

interface Props {
  clinic: Clinic;
  onClinicSaved: (patch: Partial<Clinic>) => void;
  // Fired whenever a clinic document is uploaded/re-uploaded - the parent
  // (ClinicDoctors.tsx) owns the combined "ready to submit" checklist now
  // (clinic docs + map location + at least one doctor), so it needs to know
  // when to recompute it.
  onDocumentsChanged?: () => void;
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

// Mirrors DoctorOnboardingScreen.tsx one level up: the clinic's own map
// location + document checklist. Purely presentational - the "is this
// clinic ready to submit" gate and the "Send for verification" button now
// live in the parent (ClinicDoctors.tsx), section 55, since that gate also
// depends on the Doctors block rendered below this component on the same
// page.
export default function ClinicOnboardingScreen({ clinic, onClinicSaved, onDocumentsChanged }: Props) {
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
          initialCity={clinic.city}
          onSaved={(lat, lng, formattedAddress, city) =>
            onClinicSaved({ lat, lng, formatted_address: formattedAddress, city })
          }
        />
      </div>

      <div className="mt-5">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">2. Documents</p>
        <DocumentChecklist ownerType="clinic" ownerId={clinic.id} onChanged={onDocumentsChanged} />
      </div>
    </div>
  );
}
