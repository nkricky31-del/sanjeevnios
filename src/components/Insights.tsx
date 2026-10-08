import { Search, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import { monthsBack, Panel } from './AdminDrill';
import Loading from './ui/Loading';
import { Bars, Columns, Donut, type ChartDatum } from './ui/MiniCharts';

const cap = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const COLORS: Record<string, string> = {
  completed: '#10b981', cancelled: '#f43f5e', no_show: '#94a3b8', rejected: '#fb7185', booked: '#f59e0b', accepted: '#6366f1',
  checked_in: '#0ea5e9', called: '#8b5cf6', in_consultation: '#ec4899',
  captured: '#10b981', pending: '#f59e0b', hold: '#f43f5e', refunded: '#8b5cf6',
  collected: '#0ea5e9', eligible: '#f59e0b', on_hold: '#f43f5e', released: '#6366f1', settled: '#10b981',
  online: '#6366f1', cod: '#f59e0b',
};

function countBy<T>(rows: T[], key: (r: T) => string): ChartDatum[] {
  const m: Record<string, number> = {};
  for (const r of rows) { const k = key(r); m[k] = (m[k] ?? 0) + 1; }
  return Object.entries(m).map(([k, v]) => ({ label: k === 'cod' ? 'Cash at clinic' : cap(k), value: v, color: COLORS[k] }));
}

function perMonth<T>(rows: T[], date: (r: T) => string | null | undefined, amount: (r: T) => number = () => 1, n = 6): ChartDatum[] {
  return monthsBack(n).map((m) => ({
    label: m.label,
    value: Math.round(rows.reduce((t, r) => ((date(r) ?? '').startsWith(m.key) ? t + amount(r) : t), 0)),
  }));
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 grid gap-3 sm:grid-cols-2">{children}</div>;
}

// ---- clinic: earnings ---------------------------------------------------
export function EarningsCharts({ rows }: { rows: { status: string; net_amount: number; platform_fee: number; net_payout: number | null; appointments: { date: string } | null }[] }) {
  if (rows.length === 0) return null;
  return (
    <Grid>
      <Panel title="Earned per month (₹)"><Columns color="#10b981" data={perMonth(rows, (r) => r.appointments?.date, (r) => r.net_payout ?? r.net_amount - r.platform_fee)} /></Panel>
      <Panel title="Payments by stage" delay={0.08}><Donut data={countBy(rows, (r) => r.status)} centre="payments" /></Panel>
    </Grid>
  );
}

// ---- patient: payments ----------------------------------------------------
export function PaymentsCharts({ rows }: { rows: { amount: number; method: string; status: string; created_at: string }[] }) {
  if (rows.length === 0) return null;
  const paid = rows.filter((r) => r.status === 'captured');
  return (
    <Grid>
      <Panel title="Paid per month (₹)"><Columns color="#6366f1" data={perMonth(paid, (r) => r.created_at, (r) => Number(r.amount))} /></Panel>
      <Panel title="How you pay" delay={0.08}><Donut data={countBy(rows, (r) => r.method)} centre="bills" /></Panel>
    </Grid>
  );
}

// ---- patient: appointments -------------------------------------------------
export function BookingsCharts({ rows }: { rows: { status: string; date: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <Grid>
      <Panel title="Your visits by outcome"><Donut data={countBy(rows, (r) => r.status)} centre="visits" /></Panel>
      <Panel title="Visits per month" delay={0.08}><Columns color="#0ea5e9" data={perMonth(rows, (r) => r.date)} /></Panel>
    </Grid>
  );
}

// ---- admin: reviews ---------------------------------------------------------
export function ReviewsCharts({ rows }: { rows: { rating: number; clinics: { name: string } | null }[] }) {
  if (rows.length === 0) return null;
  const avg = rows.reduce((n, r) => n + r.rating, 0) / rows.length;
  const dist: ChartDatum[] = [5, 4, 3, 2, 1].map((s) => ({ label: `${s} star${s === 1 ? '' : 's'}`, value: rows.filter((r) => r.rating === s).length, color: s >= 4 ? '#10b981' : s === 3 ? '#f59e0b' : '#f43f5e' }));
  const byClinic = Object.entries(rows.reduce<Record<string, number[]>>((m, r) => { const k = r.clinics?.name ?? 'Clinic'; (m[k] ??= []).push(r.rating); return m; }, {}))
    .map(([k, v]) => ({ label: k, value: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 })).slice(0, 6);
  return (
    <Grid>
      <Panel title={`Ratings, average ${avg.toFixed(1)} / 5`}><Bars data={dist} /></Panel>
      <Panel title="Average rating by clinic" delay={0.08}><Bars data={byClinic} /></Panel>
    </Grid>
  );
}

// ---- admin: audit log --------------------------------------------------------
export function AuditCharts({ rows }: { rows: { action: string; at: string }[] }) {
  if (rows.length === 0) return null;
  const top = countBy(rows, (r) => r.action).sort((a, b) => b.value - a.value).slice(0, 6);
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (13 - i)); return d.toISOString().slice(0, 10); });
  return (
    <Grid>
      <Panel title="Most common actions"><Bars data={top} /></Panel>
      <Panel title="Entries, last 14 days" delay={0.08}><Columns color="#6366f1" data={days.map((d) => ({ label: d.slice(8), value: rows.filter((r) => r.at.startsWith(d)).length }))} /></Panel>
    </Grid>
  );
}

// ---- admin: coupons ------------------------------------------------------------
export function CouponCharts({ rows }: { rows: { discount_amount: number; created_at: string; coupons: { code: string } | null }[] }) {
  if (rows.length === 0) return null;
  const byCode = countBy(rows, (r) => r.coupons?.code ?? 'Unknown').map((d) => ({ ...d, label: d.label.toUpperCase() })).sort((a, b) => b.value - a.value).slice(0, 6);
  return (
    <Grid>
      <Panel title="Redemptions per month"><Columns color="#ec4899" data={perMonth(rows, (r) => r.created_at)} /></Panel>
      <Panel title="Most used codes" delay={0.08}><Bars data={byCode} /></Panel>
    </Grid>
  );
}

// ---- clinic: one doctor ------------------------------------------------------------
export function DoctorInsights({ doctorId }: { doctorId: string }) {
  const [rows, setRows] = useState<{ date: string; status: string }[] | null>(null);
  useEffect(() => {
    supabase.from('appointments').select('date, status').eq('doctor_id', doctorId).limit(2000).then(({ data }) => setRows((data ?? []) as { date: string; status: string }[]));
  }, [doctorId]);
  if (rows === null) return <p className="mt-3 text-sm text-slate-400"><Loading /></p>;
  if (rows.length === 0) return <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-500">No appointments with this doctor yet.</p>;
  const done = rows.filter((r) => r.status === 'completed').length;
  const missed = rows.filter((r) => r.status === 'no_show').length;
  const weekday: ChartDatum[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((l, i) => ({ label: l, value: rows.filter((r) => new Date(r.date + 'T00:00:00').getDay() === i).length }));
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-3 space-y-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        {[['Bookings', rows.length], ['Completed', done], ['Missed', missed]].map(([l, v]) => (
          <div key={l} className="rounded-xl bg-gradient-to-br from-indigo-50 to-sky-50 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">{l}</p>
            <p className="font-display text-lg font-extrabold text-slate-900">{v}</p>
          </div>
        ))}
      </div>
      <Panel title="Outcomes"><Donut data={countBy(rows, (r) => r.status)} centre="bookings" size={116} /></Panel>
      <Panel title="Bookings per month" delay={0.06}><Columns color="#6366f1" data={perMonth(rows, (r) => r.date)} /></Panel>
      <Panel title="Busiest days" delay={0.12}><Columns color="#0ea5e9" height={70} data={weekday} /></Panel>
    </motion.div>
  );
}

// ---- clinic / admin: patients overview ----------------------------------------------
interface Seen { member_id: string; date: string; status: string; family_members: { name: string; mrn: string } | null }
export function PatientsOverview({ clinicId, onOpen }: { clinicId?: string; onOpen: (mrn: string) => void }) {
  const [rows, setRows] = useState<Seen[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    let query = supabase.from('appointments').select('member_id, date, status, family_members(name, mrn)').order('date', { ascending: false }).limit(2000);
    if (clinicId) query = query.eq('clinic_id', clinicId);
    query.then(({ data }) => setRows((data ?? []) as unknown as Seen[]));
  }, [clinicId]);

  const patients = useMemo(() => {
    const m = new Map<string, { name: string; mrn: string; visits: number; last: string }>();
    for (const r of rows ?? []) {
      if (!r.family_members) continue;
      const cur = m.get(r.member_id);
      if (cur) cur.visits += 1;
      else m.set(r.member_id, { name: r.family_members.name, mrn: r.family_members.mrn, visits: 1, last: r.date });
    }
    return [...m.values()];
  }, [rows]);

  if (rows === null) return <p className="mt-4 text-sm text-slate-400"><Loading /></p>;
  const returning = patients.filter((p) => p.visits > 1).length;
  const list = patients.filter((p) => !q || `${p.name} ${p.mrn}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="mt-5">
      <div className="mb-3 grid grid-cols-3 gap-2">
        {[['Patients', patients.length], ['Returning', returning], ['Visits', rows.length]].map(([l, v], i) => (
          <motion.div key={l} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }} className="rounded-2xl bg-gradient-to-br from-indigo-500 to-sky-500 p-3 text-white shadow-lg">
            <p className="text-[10px] uppercase tracking-wide text-white/75">{l}</p>
            <p className="font-display text-xl font-extrabold">{v}</p>
          </motion.div>
        ))}
      </div>
      <Grid>
        <Panel title="New and returning"><Donut data={[{ label: 'New', value: patients.length - returning, color: '#6366f1' }, { label: 'Returning', value: returning, color: '#10b981' }]} centre="patients" size={116} /></Panel>
        <Panel title="Visits per month" delay={0.08}><Columns color="#0ea5e9" data={perMonth(rows, (r) => r.date)} /></Panel>
      </Grid>
      <div className="mb-2 flex items-center gap-2 rounded-2xl border border-slate-100 bg-white px-3.5 py-3">
        <Search size={16} className="text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter patients you have seen" className="w-full bg-transparent text-sm outline-none" />
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {list.slice(0, 40).map((p, i) => (
          <motion.button
            key={p.mrn}
            type="button"
            onClick={() => onOpen(p.mrn)}
            data-fx="own"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i, 8) * 0.04 }}
            whileHover={{ y: -2 }}
            className="flex cursor-pointer items-center gap-3 rounded-2xl border border-slate-100 bg-white p-3 text-left shadow-sm hover:shadow-lg"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-violet-500 text-white"><Users size={17} /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-slate-900">{p.name}</span>
              <span className="block truncate font-mono text-[11px] text-slate-400">{p.mrn}</span>
            </span>
            <span className="text-right text-xs text-slate-500"><span className="block font-bold text-slate-800">{p.visits} visit{p.visits === 1 ? '' : 's'}</span>last {p.last}</span>
          </motion.button>
        ))}
        {list.length === 0 && <p className="text-sm text-slate-400">No patients match.</p>}
      </div>
    </div>
  );
}

// ---- admin: name changes ---------------------------------------------------------
export function NameChangeCharts({ rows }: { rows: { status: string; created_at: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <Grid>
      <Panel title="Requests by outcome"><Donut data={countBy(rows, (r) => r.status)} centre="requests" size={116} /></Panel>
      <Panel title="Requests per month" delay={0.08}><Columns color="#8b5cf6" data={perMonth(rows, (r) => r.created_at)} /></Panel>
    </Grid>
  );
}

// ---- admin: conditions --------------------------------------------------------------
export function ConditionCharts({ conditions }: { conditions: { name: string; is_active: boolean }[] }) {
  const [usage, setUsage] = useState<Record<string, number> | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    supabase.from('conditions_ref').select('id, name').then(({ data }) => setNames(Object.fromEntries((data ?? []).map((c: { id: string; name: string }) => [c.id, c.name]))));
    supabase.from('patient_conditions').select('condition_id').limit(5000).then(({ data, error }) => {
      if (error || !data) { setUsage({}); return; }
      const m: Record<string, number> = {};
      for (const r of data as { condition_id: string }[]) m[r.condition_id] = (m[r.condition_id] ?? 0) + 1;
      setUsage(m);
    });
  }, [conditions.length]);
  if (conditions.length === 0) return null;
  const top = Object.entries(usage ?? {}).map(([id, v]) => ({ label: names[id] ?? 'Condition', value: v })).sort((a, b) => b.value - a.value).slice(0, 6);
  const active = conditions.filter((c) => c.is_active).length;
  return (
    <Grid>
      <Panel title="Offered to patients"><Donut data={[{ label: 'Active', value: active, color: '#10b981' }, { label: 'Inactive', value: conditions.length - active, color: '#cbd5e1' }]} centre="conditions" size={116} /></Panel>
      <Panel title="Most reported by patients" delay={0.08}>{top.length ? <Bars data={top} /> : <p className="text-sm text-slate-400">No patient has reported one yet.</p>}</Panel>
    </Grid>
  );
}

// ---- clinic: billing ---------------------------------------------------------------
export function BillingCharts({ invoices, used, included }: { invoices: { amount: number; status: string; created_at: string }[]; used: number | null; included: number | null }) {
  return (
    <Grid>
      <Panel title="Invoices per month (₹)"><Columns color="#10b981" data={perMonth(invoices.filter((i) => i.status === 'paid'), (i) => i.created_at, (i) => Number(i.amount))} /></Panel>
      <Panel title="Doctors on your plan" delay={0.08}>
        {included != null && used != null ? <Bars data={[{ label: 'Doctors used', value: used, color: '#6366f1' }, { label: 'Doctors included', value: included, color: '#10b981' }]} /> : <p className="text-sm text-slate-400">No plan limit to show.</p>}
        <p className="mt-3 text-xs text-slate-500">{invoices.filter((i) => i.status === 'failed').length} failed invoice(s)</p>
      </Panel>
    </Grid>
  );
}

// ---- clinic: booking mode -----------------------------------------------------------
export function CapacityChart({ clinicId, cap }: { clinicId: string; cap: number }) {
  const [rows, setRows] = useState<{ date: string }[] | null>(null);
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d.toISOString().slice(0, 10); }), []);
  useEffect(() => {
    supabase.from('appointments').select('date').eq('clinic_id', clinicId).gte('date', days[0]).lte('date', days[13]).not('status', 'in', '(cancelled,rejected,no_show)').limit(3000).then(({ data }) => setRows((data ?? []) as { date: string }[]));
  }, [clinicId, days]);
  if (rows === null) return null;
  return (
    <div className="mt-3">
      <Panel title={`Bookings, next 14 days (daily limit ${cap})`}>
        <Columns color="#0ea5e9" data={days.map((d) => ({ label: d.slice(8), value: rows.filter((r) => r.date === d).length }))} />
        <p className="mt-2 text-xs text-slate-500">Busiest day: {Math.max(0, ...days.map((d) => rows.filter((r) => r.date === d).length))} of {cap} allowed.</p>
      </Panel>
    </div>
  );
}

// ---- clinic: a patient's history with this clinic ------------------------------------
export function PatientHistory({ memberId, clinicId }: { memberId: string; clinicId?: string }) {
  const [rows, setRows] = useState<{ date: string; status: string }[] | null>(null);
  useEffect(() => {
    let q = supabase.from('appointments').select('date, status').eq('member_id', memberId).order('date', { ascending: false }).limit(200);
    if (clinicId) q = q.eq('clinic_id', clinicId);
    q.then(({ data }) => setRows((data ?? []) as { date: string; status: string }[]));
  }, [memberId, clinicId]);
  if (rows === null) return <p className="mt-2 text-xs text-slate-400"><Loading /></p>;
  if (rows.length <= 1) return <p className="mt-2 rounded-xl bg-indigo-50 p-2.5 text-xs font-medium text-indigo-700">First visit to this clinic.</p>;
  const missed = rows.filter((r) => r.status === 'no_show').length;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-2 rounded-xl bg-slate-50 p-3">
      <p className="text-xs font-semibold text-slate-700">{rows.length} bookings here · last visit {rows[1]?.date ?? rows[0].date}{missed ? ` · ${missed} missed` : ''}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {countBy(rows, (r) => r.status).map((d) => (
          <span key={d.label} className="rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white" style={{ background: d.color ?? '#64748b' }}>{d.label} {d.value}</span>
        ))}
      </div>
    </motion.div>
  );
}

// ---- patient: home ---------------------------------------------------------------------
export function HomeCharts({ rows }: { rows: { date: string; status: string }[] }) {
  if (rows.length === 0) return null;
  const done = rows.filter((r) => r.status === 'completed').length;
  return (
    <div className="mt-6">
      <div className="mb-3 grid grid-cols-3 gap-2">
        {[['Visits', rows.length], ['Completed', done], ['This year', rows.filter((r) => r.date.startsWith(String(new Date().getFullYear()))).length]].map(([l, v], i) => (
          <motion.div key={l} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }} className="rounded-2xl bg-gradient-to-br from-indigo-500 to-sky-500 p-3 text-white shadow-lg">
            <p className="text-[10px] uppercase tracking-wide text-white/75">{l}</p>
            <p className="font-display text-xl font-extrabold">{v}</p>
          </motion.div>
        ))}
      </div>
      <Panel title="Your visits per month"><Columns color="#6366f1" data={perMonth(rows, (r) => r.date)} /></Panel>
    </div>
  );
}
