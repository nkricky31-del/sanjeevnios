import { Building2, CalendarCheck, IndianRupee, Stethoscope, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { todayISO } from '../lib/date';
import { PLATFORM_FEE_PERCENT } from '../lib/payouts';
import { supabase } from '../lib/supabaseClient';
import type { ClinicStatus } from '../lib/types';
import StatTile from './ui/StatTile';

interface Stats {
  clinicsByStatus: Record<ClinicStatus, number>;
  doctorCount: number;
  patientCount: number;
  appointmentsToday: number;
  grossCollected: number;
  platformRevenue: number;
}

const EMPTY_STATS: Stats = {
  clinicsByStatus: { draft: 0, pending: 0, approved: 0, rejected: 0 },
  doctorCount: 0,
  patientCount: 0,
  appointmentsToday: 0,
  grossCollected: 0,
  platformRevenue: 0,
};

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [{ data: clinicStatuses }, { count: doctorCount }, { count: patientCount }, { count: apptToday }, { data: capturedPayments }] =
      await Promise.all([
        supabase.from('clinics').select('status'),
        supabase.from('doctors').select('id', { count: 'exact', head: true }),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'patient'),
        supabase.from('appointments').select('id', { count: 'exact', head: true }).eq('date', todayISO()),
        // Only ONLINE captured payments are money the platform actually
        // touched - COD is paid straight to the clinic, never collected here.
        supabase.from('payments').select('amount').eq('status', 'captured').eq('method', 'online'),
      ]);

    const clinicsByStatus: Record<ClinicStatus, number> = { draft: 0, pending: 0, approved: 0, rejected: 0 };
    for (const c of clinicStatuses ?? []) {
      const status = c.status as ClinicStatus;
      clinicsByStatus[status] = (clinicsByStatus[status] ?? 0) + 1;
    }

    const grossCollected = (capturedPayments ?? []).reduce((sum, p) => sum + Number(p.amount), 0);
    const platformRevenue = Math.round(grossCollected * (PLATFORM_FEE_PERCENT / 100) * 100) / 100;

    setStats({
      clinicsByStatus,
      doctorCount: doctorCount ?? 0,
      patientCount: patientCount ?? 0,
      appointmentsToday: apptToday ?? 0,
      grossCollected,
      platformRevenue,
    });
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Platform overview</h2>
        <button onClick={load} className="text-sm font-medium text-brand-600">
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-slate-400">Loading...</p>
      ) : (
        <>
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Clinics</p>
          <div className="mt-1 grid grid-cols-3 gap-2">
            <StatTile icon={Building2} label="Approved" value={stats.clinicsByStatus.approved} tone="emerald" />
            <StatTile icon={Building2} label="Pending" value={stats.clinicsByStatus.pending} tone="amber" />
            <StatTile icon={Building2} label="Rejected" value={stats.clinicsByStatus.rejected} tone="slate" />
          </div>

          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">Platform</p>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <StatTile icon={Stethoscope} label="Doctors" value={stats.doctorCount} tone="brand" />
            <StatTile icon={Users} label="Patients" value={stats.patientCount} tone="brand" />
            <StatTile icon={CalendarCheck} label="Appointments today" value={stats.appointmentsToday} tone="brand" />
            <StatTile
              icon={IndianRupee}
              label={`Revenue (${PLATFORM_FEE_PERCENT}% fee, all-time)`}
              value={`₹${stats.platformRevenue.toLocaleString()}`}
              tone="emerald"
            />
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Gross collected online (all-time): ₹{stats.grossCollected.toLocaleString()}. COD payments aren't
            collected by the platform, so they're excluded from revenue.
          </p>
        </>
      )}
    </div>
  );
}
