import { ArrowLeft, Download } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useAuth } from '../lib/AuthContext';
import { downloadEncounterSummary } from '../lib/encounterExport';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentFile, Prescription, Visit } from '../lib/types';
import EncounterFullDetail, { type EncounterSummary, type LinkedAppointment } from './EncounterFullDetail';

interface FullEncounter extends EncounterSummary {
  mrn: string;
  family_members: { name: string } | null;
}

interface Props {
  encounterId: string;
}

// A directly-addressable "/encounters/:id" page (see App.tsx) - fetches
// the encounter by id on its own, independent of however the caller got
// here (PatientProfile.tsx's eye icon, or a pasted/typed URL). Whether
// anything comes back is decided entirely by encounters RLS (schema.sql
// section 20): admin gets any encounter, a patient gets their own (by
// mrn), a clinic gets only its own - a clinic pasting another clinic's
// encounter link lands on the "doesn't exist, or you don't have access"
// message below, not a redirect or a client-side block, because Postgres
// itself never returns the row.
export default function EncounterDetail({ encounterId }: Props) {
  const { profile } = useAuth();
  const [encounter, setEncounter] = useState<FullEncounter | null | undefined>(undefined); // undefined = loading
  const [exportData, setExportData] = useState<{
    visit: Visit | null;
    prescription: Prescription | null;
    files: AppointmentFile[];
  } | null>(null);

  useEffect(() => {
    supabase
      .from('encounters')
      .select(
        'id, encounter_no, mrn, visit_datetime, department, visit_type, reason, status, doctors(name, specialty), clinics(name), family_members(name)'
      )
      .eq('id', encounterId)
      .limit(1)
      .then(({ data }) => {
        setEncounter(((data ?? [])[0] as unknown as FullEncounter | undefined) ?? null);
      });
  }, [encounterId]);

  // Admin and patient only, per spec - a clinic can view but not export.
  const canExport = profile?.role === 'admin' || profile?.role === 'patient';

  const handleLoaded = (appointment: LinkedAppointment | null) => {
    setExportData({
      visit: appointment?.visits[0] ?? null,
      prescription: appointment?.visits[0]?.prescriptions[0] ?? null,
      files: appointment?.files ?? [],
    });
  };

  const handleExport = () => {
    if (!encounter) return;
    downloadEncounterSummary(
      {
        encounter_no: encounter.encounter_no,
        mrn: encounter.mrn,
        visit_datetime: encounter.visit_datetime,
        department: encounter.department,
        visit_type: encounter.visit_type,
        reason: encounter.reason,
        status: encounter.status,
        doctorName: encounter.doctors?.name,
        clinicName: encounter.clinics?.name,
        patientName: encounter.family_members?.name,
      },
      exportData?.visit ?? null,
      exportData?.prescription ?? null,
      exportData?.files ?? []
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between border-b border-slate-100 bg-white px-4 py-4">
        <button
          onClick={() => window.history.back()}
          className="inline-flex items-center gap-1 text-sm font-medium text-slate-500"
        >
          <ArrowLeft size={16} /> Back
        </button>
        {canExport && encounter && (
          <button
            onClick={handleExport}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-600 px-3.5 py-2 text-sm font-bold text-white"
          >
            <Download size={15} /> Export / Download
          </button>
        )}
      </div>

      <div className="mx-auto max-w-md px-4 py-6">
        {encounter === undefined && <p className="text-sm text-slate-400">Loading encounter...</p>}
        {encounter === null && (
          <p className="text-sm text-slate-400">This encounter doesn't exist, or you don't have access to view it.</p>
        )}

        {encounter && (
          <>
            <p className="font-mono text-xs font-bold text-brand-600">{encounter.encounter_no}</p>
            <p className="text-lg font-bold text-slate-900">{encounter.doctors?.name ?? 'Unknown doctor'}</p>
            <p className="text-sm text-slate-500">{encounter.clinics?.name}</p>
            {encounter.family_members?.name && (
              <p className="mt-0.5 text-xs text-slate-400">
                Patient: {encounter.family_members.name} · {encounter.mrn}
              </p>
            )}

            <div className="mt-3">
              <EncounterFullDetail encounter={encounter} onLoaded={handleLoaded} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
