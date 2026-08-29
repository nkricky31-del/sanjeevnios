import type { Prescription, Visit } from '../lib/types';

interface Props {
  visit: Visit | null;
  prescription: Prescription | null;
}

export default function VisitDetails({ visit, prescription }: Props) {
  if (!visit) return null;

  return (
    <div className="mt-4 rounded-xl border border-slate-200 p-4">
      <p className="text-sm font-semibold text-slate-900">Doctor's notes</p>
      {visit.diagnosis && <p className="mt-1 text-sm text-blue-700">Diagnosis: {visit.diagnosis}</p>}
      {visit.notes && <p className="mt-1 text-sm text-slate-600">{visit.notes}</p>}
      {visit.follow_up_date && (
        <p className="mt-1 text-sm text-slate-500">Follow-up: {visit.follow_up_date}</p>
      )}
      {!visit.diagnosis && !visit.notes && <p className="text-sm text-slate-400">No notes recorded.</p>}

      {prescription && prescription.items.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <p className="text-sm font-semibold text-slate-900">Prescription</p>
          <div className="mt-1 space-y-1">
            {prescription.items.map((drug, i) => (
              <p key={i} className="text-sm text-slate-600">
                • {drug.name} — {drug.dosage} · {drug.frequency} · {drug.durationDays}d
              </p>
            ))}
          </div>
          {prescription.status && <p className="mt-1 text-xs text-slate-400">{prescription.status}</p>}
        </div>
      )}
    </div>
  );
}
