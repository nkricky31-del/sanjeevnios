import { Building2, CalendarCheck, IndianRupee, Stethoscope, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { todayISO } from '../lib/date';
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
    const [{ data: clinicStatuses }, { count: doctorCount }, { count: patientCount }, { count: apptToday }, { data: capturedPayments }, { data: settlements }] =
      await Promise.all([
        supabase.from('clinics').select('status'),
        supabase.from('doctors').select('id', { count: 'exact', head: true }),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'patient'),
        supabase.from('appointments').select('id', { count: 'exact', head: true }).eq('date', todayISO()),
        // Only ONLINE captured payments are money the platform actually
        // touched - COD is paid straight to the clinic, never collected here.
        supabase.from('payments').select('amount').eq('status', 'captured').eq('method', 'online'),
        // Real per-plan commission (migration 59), not a flat guess - only
        // counts a row once its fee is actually known (past 'collected'),
        // same reasoning the settlement console itself uses.
        supabase.from('settlements').select('platform_fee').neq('status', 'collected'),
      ]);

    const clinicsByStatus: Record<ClinicStatus, number> = { draft: 0, pending: 0, approved: 0, rejected: 0 };
    for (const c of clinicStatuses ?? []) {
      const status = c.status as ClinicStatus;
      clinicsByStatus[status] = (clinicsByStatus[status] ?? 0) + 1;
    }

    const grossCollected = (capturedPayments ?? []).reduce((sum, p) => sum + Number(p.amount), 0);
    const platformRevenue = (settlements ?? []).reduce((sum, s) => sum + Number(s.platform_fee), 0);

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
              label="Platform commission (all-time)"
              value={`₹${stats.platformRevenue.toLocaleString()}`}
              tone="emerald"
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
