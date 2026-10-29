import Loading from './ui/Loading';
import { Building2, CalendarCheck, IndianRupee, Stethoscope, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { todayISO } from '../lib/date';
import { useAdminLive } from '../lib/adminLive';
import { supabase } from '../lib/supabaseClient';
import type { ClinicStatus } from '../lib/types';
import AdminDrill, { type DrillView } from './AdminDrill';
import StatTile from './ui/StatTile';

interface Stats {
  clinicsByStatus: Record<ClinicStatus, number>;
  doctorCount: number;
  patientCount: number;
  appointmentsToday: number;
  grossCollected: number;
  platformRevenue: number;
}

interface PlatformTotals {
  clinics_by_status: Partial<Record<ClinicStatus, number>>;
  doctors: number;
  patients: number;
  appointments_today: number;
  online_collected: number | string;
  commission_revenue: number | string;
}

const EMPTY_STATS: Stats = {
  clinicsByStatus: { draft: 0, pending: 0, approved: 0, rejected: 0 },
  doctorCount: 0,
  patientCount: 0,
  appointmentsToday: 0,
  grossCollected: 0,
  platformRevenue: 0,
};

// Before migration 88 is run: counts that are exact at any size, sums over
// what one request returns (up to 1,000 rows).
async function loadInBrowser(): Promise<Stats> {
  const statuses: ClinicStatus[] = ['draft', 'pending', 'approved', 'rejected'];
  const [statusCounts, { count: doctorCount }, { count: patientCount }, { count: apptToday }, { data: capturedPayments }, { data: settlements }] =
    await Promise.all([
      Promise.all(statuses.map((st) => supabase.from('clinics').select('id', { count: 'exact', head: true }).eq('status', st))),
      supabase.from('doctors').select('id', { count: 'exact', head: true }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'patient'),
      supabase.from('appointments').select('id', { count: 'exact', head: true }).eq('date', todayISO()),
      // Only ONLINE captured payments are money the platform actually
      // touched - COD is paid straight to the clinic, never collected here.
      supabase.from('payments').select('amount').eq('status', 'captured').eq('method', 'online'),
      // Revenue rule as Billing (migration 59): a fee counts once it is
      // final - not while collected or on hold, and not if refunded.
      supabase.from('settlements').select('platform_fee').in('status', ['eligible', 'released', 'settled']),
    ]);
  const clinicsByStatus = { ...EMPTY_STATS.clinicsByStatus };
  statuses.forEach((st, i) => {
    clinicsByStatus[st] = statusCounts[i].count ?? 0;
  });
  return {
    clinicsByStatus,
    doctorCount: doctorCount ?? 0,
    patientCount: patientCount ?? 0,
    appointmentsToday: apptToday ?? 0,
    grossCollected: (capturedPayments ?? []).reduce((sum, p) => sum + Number(p.amount), 0),
    platformRevenue: (settlements ?? []).reduce((sum, st) => sum + Number(st.platform_fee), 0),
  };
}

export default function AdminDashboard({ onNavigate }: { onNavigate?: (tab: 'patients' | 'billing') => void }) {
  const [drill, setDrill] = useState<DrillView | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    // No loading flag on a refresh: what's shown stays up until the new data
    // arrives, so reopening this tab (KeepTab) or pressing Refresh never blanks it.
    // Added up in the database (migration 88), so the figures stay right
    // however many clinics and payments there are.
    const { data, error } = await supabase.rpc('admin_platform_totals', { p_today: todayISO() });
    if (!error && data) {
      const t = data as PlatformTotals;
      setStats({
        clinicsByStatus: { ...EMPTY_STATS.clinicsByStatus, ...t.clinics_by_status },
        doctorCount: t.doctors,
        patientCount: t.patients,
        appointmentsToday: t.appointments_today,
        grossCollected: Number(t.online_collected),
        platformRevenue: Number(t.commission_revenue),
      });
    } else {
      setStats(await loadInBrowser());
    }
    setLoading(false);
  };

  // Reloads when something it shows changes, and every minute while on
  // screen (lib/adminLive.ts).
  const live = useAdminLive(['clinics', 'doctors', 'payments', 'settlements', 'subscriptions']);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  if (drill) return <AdminDrill view={drill} onChange={setDrill} onClose={() => setDrill(null)} />;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Platform overview</h2>
        <button onClick={load} className="text-sm font-medium text-brand-600">
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-slate-400"><Loading /></p>
      ) : (
        <>
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Clinics</p>
          <div className="mt-1 grid grid-cols-3 gap-2">
            <StatTile icon={Building2} label="Approved" value={stats.clinicsByStatus.approved} tone="emerald" onClick={() => setDrill({ kind: 'clinics', status: 'approved' })} />
            <StatTile icon={Building2} label="Pending" value={stats.clinicsByStatus.pending} tone="amber" onClick={() => setDrill({ kind: 'clinics', status: 'pending' })} />
            <StatTile icon={Building2} label="Rejected" value={stats.clinicsByStatus.rejected} tone="slate" onClick={() => setDrill({ kind: 'clinics', status: 'rejected' })} />
          </div>

          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">Platform</p>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <StatTile icon={Stethoscope} label="Doctors" value={stats.doctorCount} tone="brand" onClick={() => setDrill({ kind: 'doctors' })} />
            <StatTile icon={Users} label="Patients" value={stats.patientCount} tone="brand" onClick={() => onNavigate?.('patients')} />
            <StatTile icon={CalendarCheck} label="Appointments today" value={stats.appointmentsToday} tone="brand" onClick={() => setDrill({ kind: 'today' })} />
            <StatTile
              icon={IndianRupee}
              label="Platform commission (all-time)"
              value={`₹${stats.platformRevenue.toLocaleString()}`}
              tone="emerald"
              onClick={() => onNavigate?.('billing')}
            />
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Gross collected online (all-time): ₹{stats.grossCollected.toLocaleString()}. COD payments aren't
            collected by the platform, so they're excluded. See the Settlements tab for what's eligible, released,
            and settled.
          </p>
        </>
      )}
    </div>
  );
}
