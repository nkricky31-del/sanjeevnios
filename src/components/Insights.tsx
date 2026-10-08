import { Search, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { supabase } from '../lib/supabaseClient';
import { Banner, monthsBack, Panel } from './AdminDrill';
import Loading from './ui/Loading';
import StatusPill from './ui/StatusPill';
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
interface Seen {
  id: string; member_id: string; date: string; slot_time: string; status: string;
  doctors: { name: string } | null; family_members: { name: string; mrn: string } | null;
}
interface PatientAgg { memberId: string; name: string; mrn: string; visits: number; last: string; first: string }
type Sec = null | 'patients' | 'returning' | 'visits' | 'mix' | 'months';

export function PatientsOverview({ clinicId, onOpen }: { clinicId?: string; onOpen: (mrn: string) => void }) {
  const [rows, setRows] = useState<Seen[] | null>(null);
  const [q, setQ] = useState('');
  const [sec, setSec] = useState<Sec>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  useEffect(() => {
    let query = supabase.from('appointments').select('id, member_id, date, slot_time, status, doctors(name), family_members(name, mrn)').order('date', { ascending: false }).limit(2000);
    if (clinicId) query = query.eq('clinic_id', clinicId);
    query.then(({ data }) => setRows((data ?? []) as unknown as Seen[]));
  }, [clinicId]);

  const patients = useMemo<PatientAgg[]>(() => {
    const m = new Map<string, PatientAgg>();
    for (const r of rows ?? []) {
      if (!r.family_members) continue;
      const cur = m.get(r.member_id);
      if (cur) { cur.visits += 1; cur.first = r.date; }
      else m.set(r.member_id, { memberId: r.member_id, name: r.family_members.name, mrn: r.family_members.mrn, visits: 1, last: r.date, first: r.date });
    }
    return [...m.values()];
  }, [rows]);

  if (rows === null) return <p className="mt-4 text-sm text-slate-400"><Loading /></p>;
  const returning = patients.filter((p) => p.visits > 1);
  const fresh = patients.filter((p) => p.visits <= 1);
  const matches = (p: PatientAgg) => !q || `${p.name} ${p.mrn}`.toLowerCase().includes(q.toLowerCase());

  const patientCard = (p: PatientAgg, i: number) => (
    <motion.button
      key={p.memberId}
      type="button"
      onClick={() => onOpen(p.mrn)}
      data-fx="own"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(i, 8) * 0.04 }}
      whileHover={{ y: -2 }}
      className="flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-slate-100 bg-white p-3 text-left shadow-sm hover:shadow-lg"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-violet-500 text-white"><Users size={17} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold text-slate-900">{p.name}</span>
        <span className="block truncate font-mono text-[11px] text-slate-400">{p.mrn}</span>
      </span>
      <span className="text-right text-xs text-slate-500"><span className="block font-bold text-slate-800">{p.visits} visit{p.visits === 1 ? '' : 's'}</span>last {p.last}</span>
    </motion.button>
  );
  const searchBox = (
    <div className="mb-3 flex items-center gap-2 rounded-2xl border border-slate-100 bg-white px-3.5 py-3">
      <Search size={16} className="text-slate-400" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or MRN" className="w-full bg-transparent text-sm outline-none" />
    </div>
  );
  const chips = [{ label: 'Patients', value: String(patients.length) }, { label: 'Returning', value: String(returning.length) }, { label: 'Visits', value: String(rows.length) }];
  const back = () => { setSec(null); setQ(''); setMonth(null); setStatusFilter(null); };

  // ---- the pages ----
  if (sec === 'patients') {
    const list = patients.filter(matches);
    const top = [...patients].sort((a, b) => b.visits - a.visits).slice(0, 6).map((p) => ({ label: p.name, value: p.visits }));
    return (
      <div className="mt-5 space-y-4">
        <Banner title="All patients" sub="Everyone who has booked here. Tap one to open their record." icon={Users} from="#6366f1" to="#38bdf8" onBack={back} chips={chips} />
        <Panel title="Most visits"><Bars data={top} /></Panel>
        {searchBox}
        <div className="grid gap-2 md:grid-cols-2">{list.map((p, i) => patientCard(p, i))}{list.length === 0 && <p className="text-sm text-slate-400">No patients match.</p>}</div>
      </div>
    );
  }
  if (sec === 'returning') {
    const list = returning.filter(matches).sort((a, b) => b.visits - a.visits);
    return (
      <div className="mt-5 space-y-4">
        <Banner title="Returning patients" sub="People who have come back more than once." icon={Users} from="#10b981" to="#a3e635" onBack={back} chips={chips} />
        {returning.length === 0 ? (
          <Panel title="Nobody yet"><p className="text-sm text-slate-500">No patient has come back for a second visit so far. They will appear here as soon as one does.</p></Panel>
        ) : (
          <>
            <Panel title="Visits per returning patient"><Bars data={list.slice(0, 8).map((p) => ({ label: p.name, value: p.visits }))} /></Panel>
            {searchBox}
            <div className="grid gap-2 md:grid-cols-2">{list.map((p, i) => patientCard(p, i))}</div>
          </>
        )}
      </div>
    );
  }
  if (sec === 'visits') {
    const statusData = countBy(rows, (r) => r.status);
    const shown = rows.filter((r) => !statusFilter || cap(r.status) === statusFilter).slice(0, 200);
    return (
      <div className="mt-5 space-y-4">
        <Banner title="All visits" sub="Every booking, newest first." icon={Users} from="#0ea5e9" to="#6366f1" onBack={back} chips={chips} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Panel title="By outcome"><Donut data={statusData} centre="visits" size={116} /></Panel>
          <Panel title="Per month" delay={0.08}><Columns color="#0ea5e9" data={perMonth(rows, (r) => r.date)} /></Panel>
        </div>
        <div className="flex flex-wrap gap-2">
          {[null, ...statusData.map((d) => d.label)].map((l) => (
            <button key={l ?? 'all'} type="button" data-fx="own" onClick={() => setStatusFilter(l)} className={`cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${statusFilter === l ? 'bg-slate-900 text-white shadow-lg' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-slate-400'}`}>{l ?? 'All'}</button>
          ))}
        </div>
        <div className="space-y-2">
          {shown.map((r, i) => (
            <motion.button key={r.id} type="button" data-fx="own" onClick={() => r.family_members && onOpen(r.family_members.mrn)} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 10) * 0.03 }} className="flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-slate-100 bg-white p-3 text-left hover:shadow-md">
              <span className="w-24 shrink-0 text-xs font-bold text-indigo-600">{r.date}<span className="block font-normal text-slate-400">{r.slot_time.slice(0, 5)}</span></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{r.family_members?.name ?? 'Patient'}</span><span className="block truncate text-xs text-slate-500">{r.doctors?.name ?? 'Doctor'}</span></span>
              <StatusPill label={cap(r.status)} tone={r.status === 'completed' ? 'live' : ['cancelled', 'rejected'].includes(r.status) ? 'danger' : r.status === 'booked' ? 'warning' : 'neutral'} />
            </motion.button>
          ))}
        </div>
      </div>
    );
  }
  if (sec === 'mix') {
    return (
      <div className="mt-5 space-y-4">
        <Banner title="New and returning" sub="First-time patients next to the ones who came back." icon={Users} from="#6366f1" to="#10b981" onBack={back} chips={chips} />
        <Panel title="The split"><Donut size={160} centre="patients" data={[{ label: 'New', value: fresh.length, color: '#6366f1' }, { label: 'Returning', value: returning.length, color: '#10b981' }]} /></Panel>
        <div className="grid gap-4 lg:grid-cols-2">
          <div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-indigo-600">New ({fresh.length})</p><div className="space-y-2">{fresh.map((p, i) => patientCard(p, i))}{fresh.length === 0 && <p className="text-sm text-slate-400">None.</p>}</div></div>
          <div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-emerald-600">Returning ({returning.length})</p><div className="space-y-2">{returning.map((p, i) => patientCard(p, i))}{returning.length === 0 && <p className="text-sm text-slate-400">None yet.</p>}</div></div>
        </div>
      </div>
    );
  }
  if (sec === 'months') {
    const months = monthsBack(12);
    const sel = month ?? [...months].reverse().find((m) => rows.some((r) => r.date.startsWith(m.key)))?.key ?? months[months.length - 1].key;
    const inMonth = rows.filter((r) => r.date.startsWith(sel));
    return (
      <div className="mt-5 space-y-4">
        <Banner title="Visits by month" sub="Pick a month to see who came in." icon={Users} from="#0ea5e9" to="#14b8a6" onBack={back} chips={chips} />
        <Panel title="Last 12 months"><Columns color="#0ea5e9" data={months.map((m) => ({ label: m.label, value: rows.filter((r) => r.date.startsWith(m.key)).length }))} /></Panel>
        <div className="flex flex-wrap gap-2">
          {months.map((m) => (
            <button key={m.key} type="button" data-fx="own" onClick={() => setMonth(m.key)} className={`cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${sel === m.key ? 'bg-sky-600 text-white shadow-lg' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-slate-400'}`}>{m.label} · {rows.filter((r) => r.date.startsWith(m.key)).length}</button>
          ))}
        </div>
        {inMonth.length === 0 ? <p className="text-sm text-slate-500">No visits in this month.</p> : (
          <>
            <Panel title="Outcomes that month"><Donut data={countBy(inMonth, (r) => r.status)} centre="visits" size={116} /></Panel>
            <div className="space-y-2">
              {inMonth.map((r, i) => (
                <motion.button key={r.id} type="button" data-fx="own" onClick={() => r.family_members && onOpen(r.family_members.mrn)} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 10) * 0.03 }} className="flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-slate-100 bg-white p-3 text-left hover:shadow-md">
                  <span className="w-24 shrink-0 text-xs font-bold text-sky-600">{r.date}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{r.family_members?.name ?? 'Patient'}</span>
                  <StatusPill label={cap(r.status)} tone={r.status === 'completed' ? 'live' : ['cancelled', 'rejected'].includes(r.status) ? 'danger' : 'neutral'} />
                </motion.button>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  // ---- the overview ----
  const tiles: [string, number, Sec, string][] = [
    ['Patients', patients.length, 'patients', 'from-indigo-500 to-sky-500'],
    ['Returning', returning.length, 'returning', 'from-emerald-500 to-lime-400'],
    ['Visits', rows.length, 'visits', 'from-sky-500 to-violet-500'],
  ];
  return (
    <div className="mt-5">
      <div className="mb-3 grid grid-cols-3 gap-2">
        {tiles.map(([l, v, to, grad], i) => (
          <motion.button key={l} type="button" data-fx="own" onClick={() => setSec(to)} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }} whileHover={{ y: -4, scale: 1.03 }} whileTap={{ scale: 0.96 }} className={`cursor-pointer rounded-2xl bg-gradient-to-br ${grad} p-3 text-left text-white shadow-lg hover:shadow-xl`}>
            <p className="text-[10px] uppercase tracking-wide text-white/75">{l}</p>
            <p className="font-display text-xl font-extrabold">{v}</p>
          </motion.button>
        ))}
      </div>
      <Grid>
        <Panel title="New and returning" onOpen={() => setSec('mix')} accent="#6366f1"><Donut data={[{ label: 'New', value: fresh.length, color: '#6366f1' }, { label: 'Returning', value: returning.length, color: '#10b981' }]} centre="patients" size={116} /></Panel>
        <Panel title="Visits per month" delay={0.08} onOpen={() => setSec('months')} accent="#0ea5e9"><Columns color="#0ea5e9" data={perMonth(rows, (r) => r.date)} /></Panel>
      </Grid>
      {searchBox}
      <div className="grid gap-2 md:grid-cols-2">
        {patients.filter(matches).slice(0, 40).map((p, i) => patientCard(p, i))}
        {patients.filter(matches).length === 0 && <p className="text-sm text-slate-400">No patients match.</p>}
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
  const navigate = useNavigate();
  if (rows.length === 0) return null;
  const done = rows.filter((r) => r.status === 'completed').length;
  const tiles: [string, number, string, string][] = [
    ['Visits', rows.length, '/bookings', 'from-indigo-500 to-sky-500'],
    ['Completed', done, '/bookings?tab=completed', 'from-emerald-500 to-teal-500'],
    ['This year', rows.filter((r) => r.date.startsWith(String(new Date().getFullYear()))).length, '/bookings', 'from-pink-500 to-violet-500'],
  ];
  return (
    <div className="mt-6">
      <div className="mb-3 grid grid-cols-3 gap-2">
        {tiles.map(([l, v, to, grad], i) => (
          <motion.button
            key={l}
            type="button"
            onClick={() => navigate(to)}
            data-fx="own"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07 }}
            whileHover={{ y: -4, scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            className={`cursor-pointer rounded-2xl bg-gradient-to-br ${grad} p-3 text-left text-white shadow-lg transition-shadow hover:shadow-xl`}
          >
            <p className="text-[10px] uppercase tracking-wide text-white/75">{l}</p>
            <p className="font-display text-xl font-extrabold">{v}</p>
          </motion.button>
        ))}
      </div>
      <Panel title="Your visits per month"><Columns color="#6366f1" data={perMonth(rows, (r) => r.date)} /></Panel>
    </div>
  );
}
