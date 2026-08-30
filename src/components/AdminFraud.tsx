import { useEffect, useState } from 'react';

import { FRAUD_THRESHOLDS, isFlagged, type ClinicFraudStats } from '../lib/fraud';
import { supabase } from '../lib/supabaseClient';
import Card from './ui/Card';
import StatusPill from './ui/StatusPill';
import SuspendUserForm from './SuspendUserForm';

interface AppointmentRow {
  clinic_id: string;
  status: string;
  clinics: { name: string } | null;
}

interface RefundedPaymentRow {
  appointments: { clinic_id: string } | null;
}

// Fetch caps for this MVP admin view - see AdminPayments.tsx for the same
// reasoning (large enough for realistic test/demo volume).
const FETCH_LIMIT = 2000;

export default function AdminFraud() {
  const [stats, setStats] = useState<ClinicFraudStats[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [{ data: appts }, { data: refunds }] = await Promise.all([
      supabase
        .from('appointments')
        .select('clinic_id, status, clinics(name)')
        .in('status', ['rejected', 'no_show'])
        .limit(FETCH_LIMIT),
      supabase
        .from('payments')
        .select('appointments(clinic_id)')
        .eq('status', 'refunded')
        .limit(FETCH_LIMIT),
    ]);

    const byClinic = new Map<string, ClinicFraudStats>();
    const get = (clinicId: string, clinicName: string) => {
      const existing = byClinic.get(clinicId);
      if (existing) return existing;
      const fresh: ClinicFraudStats = { clinicId, clinicName, rejections: 0, noShows: 0, refunds: 0, flagged: false };
      byClinic.set(clinicId, fresh);
      return fresh;
    };

    for (const a of (appts ?? []) as unknown as AppointmentRow[]) {
      const entry = get(a.clinic_id, a.clinics?.name ?? 'Unknown clinic');
      if (a.status === 'rejected') entry.rejections++;
      else if (a.status === 'no_show') entry.noShows++;
    }
    for (const p of (refunds ?? []) as unknown as RefundedPaymentRow[]) {
      const clinicId = p.appointments?.clinic_id;
      if (!clinicId) continue;
      const entry = get(clinicId, byClinic.get(clinicId)?.clinicName ?? 'Unknown clinic');
      entry.refunds++;
    }

    const rows = Array.from(byClinic.values()).map((s) => ({ ...s, flagged: isFlagged(s) }));
    rows.sort((a, b) => (a.flagged === b.flagged ? 0 : a.flagged ? -1 : 1));
    setStats(rows);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <SuspendUserForm />

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Fraud watch</h2>
        <button onClick={load} className="text-sm font-medium text-blue-600">
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Flags a clinic once it crosses {FRAUD_THRESHOLDS.rejections} rejections, {FRAUD_THRESHOLDS.noShows}{' '}
        no-shows, or {FRAUD_THRESHOLDS.refunds} refunds. A signal to review, not an automatic action.
      </p>

      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && stats.length === 0 && <p className="text-sm text-slate-400">No rejections, no-shows, or refunds recorded yet.</p>}
        {stats.map((s) => (
          <Card key={s.clinicId}>
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-900">{s.clinicName}</p>
              {s.flagged && <StatusPill label="Flagged" tone="warning" />}
            </div>
            <p className="text-sm text-slate-600">
              {s.rejections} rejection{s.rejections === 1 ? '' : 's'} · {s.noShows} no-show
              {s.noShows === 1 ? '' : 's'} · {s.refunds} refund{s.refunds === 1 ? '' : 's'}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}
