import { useCallback, useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { Clinic } from '../lib/types';
import Card from './ui/Card';

interface AuditRow {
  id: string;
  at: string;
  action: string;
  actor_name: string | null;
  actor_role: string | null;
  resource_type: string | null;
  resource_id: string | null;
  details: Record<string, unknown>;
  reason: string | null;
}

const ACTIONS = [
  'staff.added',
  'staff.role_changed',
  'staff.removed',
  'appointment.created',
  'appointment.status_changed',
  'appointment.rescheduled',
  'patient.health.read',
  'patient.health.download',
  'patient.export',
  'document.uploaded',
  'booking.override',
];

const PAGE = 100;

// Read-only. There is deliberately no edit or delete anywhere in this file:
// the table refuses both for every app role (migration 70). The clinic filter
// below is a convenience - the database already limits rows to this clinic.
export default function ClinicAuditLog({ clinic }: { clinic: Clinic }) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    supabase
      .rpc('has_clinic_permission', { p_clinic_id: clinic.id, p_permission: 'audit.read' })
      .then(({ data }) => setAllowed(data === true));
  }, [clinic.id]);

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from('audit_log')
      .select('id, at, action, actor_name, actor_role, resource_type, resource_id, details, reason')
      .eq('clinic_id', clinic.id)
      .order('at', { ascending: false })
      .limit(PAGE);
    if (action) q = q.eq('action', action);
    if (from) q = q.gte('at', new Date(`${from}T00:00:00`).toISOString());
    if (to) q = q.lte('at', new Date(`${to}T23:59:59`).toISOString());
    const { data } = await q;
    setRows((data ?? []) as AuditRow[]);
    setLoading(false);
  }, [clinic.id, action, from, to]);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  if (!allowed) return null;

  // One timezone for every row: the clinic's own.
  const tz = clinic.timezone || 'Asia/Kolkata';
  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-IN', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' });

  return (
    <div className="mt-6">
      <h2 className="text-lg font-bold text-slate-900">Audit trail</h2>
      <p className="mt-1 text-xs text-slate-400">
        Who did what at this clinic. Entries can't be edited or deleted. Times are in {tz}.
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label="Filter by action"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
        >
          <option value="">All actions</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" />
        <button onClick={load} className="text-sm font-medium text-brand-600">
          Refresh
        </button>
      </div>

      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && rows.length === 0 && <p className="text-sm text-slate-400">No entries match.</p>}
        {rows.map((r) => (
          <Card key={r.id}>
            <p className="font-semibold text-slate-900">{r.action}</p>
            <p className="text-xs text-slate-500">
              By {r.actor_name ?? 'unknown'}
              {r.actor_role ? ` (${r.actor_role})` : ''}
              {r.resource_type ? ` · ${r.resource_type}` : ''}
            </p>
            {r.resource_id && <p className="font-mono text-xs text-slate-400">{r.resource_id}</p>}
            {Object.keys(r.details ?? {}).length > 0 && (
              <p className="mt-1 break-words font-mono text-xs text-slate-400">{JSON.stringify(r.details)}</p>
            )}
            {r.reason && <p className="mt-1 text-xs text-slate-600">Reason: {r.reason}</p>}
            <p className="mt-1 text-xs text-slate-400">{when(r.at)}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
