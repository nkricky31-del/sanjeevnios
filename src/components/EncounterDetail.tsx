import { Download } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';

import { useAuth } from '../lib/AuthContext';
import { downloadEncounterSummary } from '../lib/encounterExport';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentFile, Prescription, Visit } from '../lib/types';
import EncounterFullDetail, { type EncounterSummary, type LinkedAppointment } from './EncounterFullDetail';
import ScreenHeader from './ui/ScreenHeader';

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
    // Clinic staff only see a patient's clinical data after an audited open
    // (migration 68); for a patient or admin this is a no-op. Either way the
    // encounters read below is what decides what's actually shown.
    supabase
      .rpc('open_encounter_health_record', { p_encounter_id: encounterId })
      .then(() =>
        supabase
          .from('encounters')
          .select(
            'id, encounter_no, mrn, visit_datetime, department, visit_type, reason, status, doctors(name, specialty), clinics(name), family_members(name)'
          )
          .eq('id', encounterId)
          .limit(1)
      )
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
      <ScreenHeader
        title="Encounter / Visit Details"
        onBack={() => window.history.back()}
        action={
          canExport && encounter ? (
            <button
              onClick={handleExport}
              aria-label="Export encounter"
              className="rounded-full p-2 text-brand-600 hover:bg-brand-50"
            >
              <Download size={19} />
            </button>
          ) : undefined
        }
      />

      <div className="mx-auto max-w-3xl px-4 py-4">
        {encounter === undefined && <p className="text-sm text-slate-400">Loading encounter...</p>}
        {encounter === null && (
          <p className="text-sm text-slate-400">This encounter doesn't exist, or you don't have access to view it.</p>
        )}

        {encounter && (
          <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
            <motion.div
              className="relative overflow-hidden rounded-2xl p-4 text-white"
              style={{ background: 'var(--band-bg)' }}
              initial={{ scale: 0.97 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 160, damping: 16 }}
            >
              <motion.span
                aria-hidden
                className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/15"
                animate={{ scale: [1, 1.25, 1], x: [0, -10, 0] }}
                transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
              />
              <p className="relative font-mono text-xs font-bold text-white/80">{encounter.encounter_no}</p>
              <p className="relative text-lg font-bold">{encounter.doctors?.name ?? 'Unknown doctor'}</p>
              <p className="relative text-sm text-white/80">{encounter.clinics?.name}</p>
              {encounter.family_members?.name && (
                <p className="relative mt-0.5 text-xs text-white/70">
                  Patient: {encounter.family_members.name} · {encounter.mrn}
                </p>
              )}
            </motion.div>

            <motion.div
              className="mt-3 rise-in"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.15 }}
            >
              <EncounterFullDetail encounter={encounter} onLoaded={handleLoaded} />
            </motion.div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
