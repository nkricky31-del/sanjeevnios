import Loading from './ui/Loading';
import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import Card from './ui/Card';
import StatusPill from './ui/StatusPill';

interface Props {
  doctorId: string;
  onOpen: (appointmentId: string, patientName: string) => void;
}

// One row of clinic_rx_worklist() (migration 68): only what this list shows -
// never the visit's notes or diagnosis.
interface WorklistRow {
  visit_id: string;
  appointment_id: string;
  patient_name: string | null;
  token_number: number | null;
  date: string;
  slot_time: string;
  doctor_id: string;
}

interface IncompleteVisit {
  visitId: string;
  appointmentId: string;
  patientName: string;
  date: string;
  slotTime: string;
  tokenNo: number | null;
}

export default function RxPendingWorklist({ doctorId, onOpen }: Props) {
  const [rows, setRows] = useState<IncompleteVisit[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    // The server already returns only visits still missing a prescription,
    // for the caller's own clinic.
    const { data } = await supabase.rpc('clinic_rx_worklist', { p_since: '2000-01-01' });

    const raw = (data ?? []) as WorklistRow[];
    const incomplete = raw
      .filter((v) => v.doctor_id === doctorId)
      .map((v) => ({
        visitId: v.visit_id,
        appointmentId: v.appointment_id,
        patientName: v.patient_name ?? 'Unknown',
        date: v.date,
        slotTime: v.slot_time,
        tokenNo: v.token_number,
      }))
      .sort((a, b) => (a.date === b.date ? a.slotTime.localeCompare(b.slotTime) : b.date.localeCompare(a.date)));

    setRows(incomplete);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Rx pending</h2>
        <button onClick={load} className="text-sm font-medium text-brand-600">
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">Visits still missing an e-prescription or a "no prescription" note.</p>

      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400"><Loading /></p>}
        {!loading && rows.length === 0 && <p className="text-sm text-slate-400">Nothing pending.</p>}
        {rows.map((r) => (
          <Card key={r.visitId} onOpen={() => onOpen(r.appointmentId, r.patientName)} accent="#f59e0b">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-900">
                {r.tokenNo ? `#${r.tokenNo} — ` : ''}
                {r.patientName}
              </p>
              <StatusPill label="Rx pending" tone="warning" />
            </div>
            <p className="text-sm text-slate-500">
              {r.date} at {r.slotTime?.slice(0, 5)}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}
