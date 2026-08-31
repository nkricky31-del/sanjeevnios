import { useEffect, useState } from 'react';

import { openAppointmentFile } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentFile, AppointmentStatus, Prescription, Visit } from '../lib/types';
import VisitDetails from './VisitDetails';
import StatusPill from './ui/StatusPill';

export interface EncounterSummary {
  id: string;
  encounter_no: string;
  visit_datetime: string;
  department: string | null;
  visit_type: string;
  reason: string | null;
  status: string;
  doctors: { name: string; specialty: string | null } | null;
  clinics: { name: string } | null;
}

export interface LinkedAppointment {
  id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  visits: (Visit & { prescriptions: Prescription[] })[];
  files: AppointmentFile[];
}

const FILE_LABEL: Record<string, string> = {
  lab_report: 'Lab report',
  prescription: 'Prescription',
  xray: 'X-ray',
  photo: 'Photo',
};

interface Props {
  encounter: EncounterSummary;
  // Fires once the linked appointment/visit/prescription/files finish
  // loading (or resolve to "none found") - EncounterDetail.tsx uses this to
  // build the Export/Download file without re-fetching the same data.
  onLoaded?: (appointment: LinkedAppointment | null) => void;
}

// Everything about ONE visit below the encounter's own header fields
// (which the caller already has and renders itself, differently, in the
// modal vs. the standalone page): department/visit type/reason, then
// clinical notes, diagnosis, prescription, and files - pulled from the
// appointment/visit this encounter is linked to (see schema.sql section 18,
// create_encounter_for_appointment()).
export default function EncounterFullDetail({ encounter, onLoaded }: Props) {
  const [appointment, setAppointment] = useState<LinkedAppointment | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    supabase
      .from('appointments')
      .select(
        'id, date, slot_time, status, visits(id, appointment_id, notes, diagnosis, follow_up_date, no_prescription, created_at, prescriptions(id, visit_id, items, file_url, signed_by, status, created_at)), files(id, member_id, appointment_id, type, storage_path, created_at)'
      )
      .eq('encounter_id', encounter.id)
      .limit(1)
      .then(({ data }) => {
        const found = ((data ?? [])[0] as LinkedAppointment | undefined) ?? null;
        setAppointment(found);
        onLoaded?.(found);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounter.id]);

  const visit = appointment?.visits[0];
  const prescription = visit?.prescriptions[0];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill label={encounter.status} tone="info" />
        <span className="text-xs text-slate-400">{new Date(encounter.visit_datetime).toLocaleString()}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
        <p>
          <span className="text-slate-400">Department:</span> {encounter.department ?? '—'}
        </p>
        <p>
          <span className="text-slate-400">Visit type:</span> {encounter.visit_type}
        </p>
        <p className="col-span-2">
          <span className="text-slate-400">Reason:</span> {encounter.reason ?? '—'}
        </p>
      </div>

      {appointment === undefined && <p className="mt-4 text-sm text-slate-400">Loading visit details...</p>}
      {appointment === null && (
        <p className="mt-4 text-sm text-slate-400">No linked visit record found for this encounter.</p>
      )}

      {appointment && (
        <>
          <VisitDetails visit={visit ?? null} prescription={prescription ?? null} />
          {appointment.files.length > 0 && (
            <div className="mt-3 rounded-xl border border-slate-200 p-4">
              <p className="text-sm font-semibold text-slate-900">Tests / Reports</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {appointment.files.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => openAppointmentFile(f.storage_path)}
                    className="rounded-lg bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700"
                  >
                    {f.type ? FILE_LABEL[f.type] : 'File'}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
