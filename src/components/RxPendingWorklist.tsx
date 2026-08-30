import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import Button from './ui/Button';
import Card from './ui/Card';
import StatusPill from './ui/StatusPill';

interface Props {
  doctorId: string;
  onOpen: (appointmentId: string, patientName: string) => void;
}

interface RawVisitRow {
  id: string;
  appointment_id: string;
  no_prescription: boolean;
  appointments: {
    date: string;
    slot_time: string;
    token_no: number | null;
    family_members: { name: string } | null;
  } | null;
  prescriptions: { status: string }[];
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
    const { data } = await supabase
      .from('visits')
      .select(
        'id, appointment_id, no_prescription, appointments!inner(date, slot_time, token_no, doctor_id, family_members(name)), prescriptions(status)'
      )
      .eq('appointments.doctor_id', doctorId);

    const raw = (data ?? []) as unknown as RawVisitRow[];
    const incomplete = raw
      .filter((v) => !v.no_prescription && !v.prescriptions.some((p) => p.status === 'attached') && v.appointments)
      .map((v) => ({
        visitId: v.id,
        appointmentId: v.appointment_id,
        patientName: v.appointments?.family_members?.name ?? 'Unknown',
        date: v.appointments!.date,
        slotTime: v.appointments!.slot_time,
        tokenNo: v.appointments!.token_no,
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
        <button onClick={load} className="text-sm font-medium text-blue-600">
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">Visits still missing an e-prescription or a "no prescription" note.</p>

      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && rows.length === 0 && <p className="text-sm text-slate-400">Nothing pending.</p>}
        {rows.map((r) => (
          <Card key={r.visitId}>
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
            <Button className="mt-2" onClick={() => onOpen(r.appointmentId, r.patientName)}>
              Open visit
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
