import { Printer } from 'lucide-react';
import { useState } from 'react';

import type { Prescription, Visit } from '../lib/types';
import { useRxLanguage } from '../lib/useRxLanguage';
import PrescriptionItems, { RxLanguageToggle } from './rx/PrescriptionItems';
import PrescriptionSheet from './rx/PrescriptionSheet';

interface Props {
  visit: Visit | null;
  prescription: Prescription | null;
  // For the printable prescription's header, when the caller knows them.
  patientName?: string | null;
  doctorName?: string | null;
  clinicName?: string | null;
}

export default function VisitDetails({ visit, prescription, patientName, doctorName, clinicName }: Props) {
  const [language, setLanguage] = useRxLanguage();
  const [printing, setPrinting] = useState(false);

  if (!visit) return null;

  return (
    <div className="mt-4 rounded-xl border border-slate-200 p-4">
      <p className="text-sm font-semibold text-slate-900">Doctor's notes</p>
      {visit.diagnosis && <p className="mt-1 text-sm text-brand-700">Diagnosis: {visit.diagnosis}</p>}
      {visit.notes && <p className="mt-1 text-sm text-slate-600">{visit.notes}</p>}
      {visit.follow_up_due_date && (
        <p className="mt-1 text-sm text-slate-500">
          Follow-up recommended by{' '}
          {new Date(visit.follow_up_due_date + 'T00:00:00').toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </p>
      )}
      {!visit.diagnosis && !visit.notes && <p className="text-sm text-slate-400">No notes recorded.</p>}

      {prescription && prescription.items.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">Prescription</p>
            <RxLanguageToggle value={language} onChange={setLanguage} />
          </div>
          <div className="mt-2">
            <PrescriptionItems
              items={prescription.items}
              adviceEn={prescription.advice_en}
              adviceHi={prescription.advice_hi}
              language={language}
            />
          </div>
          <button
            type="button"
            onClick={() => setPrinting(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
          >
            <Printer size={14} /> Print / save as PDF
          </button>
        </div>
      )}

      {printing && prescription && (
        <PrescriptionSheet
          prescription={prescription}
          patientName={patientName}
          diagnosis={visit.diagnosis}
          followUpDate={visit.follow_up_due_date}
          fallbackDoctorName={doctorName}
          fallbackClinicName={clinicName}
          onClose={() => setPrinting(false)}
        />
      )}
    </div>
  );
}
