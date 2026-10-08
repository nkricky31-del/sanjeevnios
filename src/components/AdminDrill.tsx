import { ArrowLeft, BadgeCheck, Banknote, Building2, CalendarCheck, ChevronRight, IndianRupee, Mail, ShieldAlert, MapPin, Phone, Search, Stethoscope } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { todayISO } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import type { Clinic, ClinicStatus } from '../lib/types';
import { FRAUD_THRESHOLDS } from '../lib/fraud';
import { Bars, Columns, Donut, type ChartDatum } from './ui/MiniCharts';
import Loading from './ui/Loading';
import StatusPill from './ui/StatusPill';

export type DrillView =
  | { kind: 'clinics'; status: ClinicStatus | 'all' }
  | { kind: 'clinic'; id: string; from: ClinicStatus | 'all' | 'close' }
  | { kind: 'doctors' }
  | { kind: 'today' }
  | { kind: 'fraud'; clinicId: string }
  | { kind: 'payment'; id: string }
  | { kind: 'payout'; clinicId: string }
  | { kind: 'doctor'; id: string }
  | { kind: 'settlement'; id: string };

type ClinicRow = Pick<Clinic, 'id' | 'name' | 'status' | 'city' | 'clinic_code' | 'subscription_tier' | 'is_active' | 'is_verified' | 'contact_phone' | 'created_at'>;
interface DoctorRow {
  id: string;
  clinic_id: string;
  name: string;
  specialty: string | null;
  status: string;
  consultation_fee: number;
  is_active: boolean;
  is_verified: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  approved: '#10b981', pending: '#f59e0b', rejected: '#94a3b8', draft: '#cbd5e1',
  completed: '#10b981', cancelled: '#f43f5e', no_show: '#94a3b8', rejected_: '#94a3b8',
  booked: '#f59e0b', accepted: '#6366f1', checked_in: '#0ea5e9', called: '#8b5cf6', in_consultation: '#ec4899',
};
const TONE: Record<string, 'live' | 'warning' | 'neutral' | 'danger'> = { approved: 'live', pending: 'warning', rejected: 'danger', draft: 'neutral' };
const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
const cap = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function Panel({ title, children, delay = 0, onOpen, accent }: { title: string; children: ReactNode; delay?: number; onOpen?: () => void; accent?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.45 }}
      data-open={onOpen ? 'true' : undefined}
      role={onOpen ? 'link' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? (e) => { if (!(e.target as HTMLElement).closest('button, a, input, select')) onOpen(); } : undefined}
      onKeyDown={onOpen ? (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } } : undefined}
      style={accent ? ({ '--accent': accent } as React.CSSProperties) : undefined}
      className={`${onOpen ? 'relative cursor-pointer ' : ''}rounded-2xl border border-slate-100 bg-white p-4`}
    >
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{title}</p>
      {children}
      {onOpen && <span aria-hidden className="open-hint">Open</span>}
    </motion.div>
  );
}

export function Banner({ title, sub, icon: Icon, from, to, onBack, chips }: {
  title: string; sub: string; icon: typeof Building2; from: string; to: string; onBack: () => void; chips: { label: string; value: string }[];
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-3xl p-5 text-white"
      style={{ background: `linear-gradient(120deg, ${from}, ${to})` }}
    >
      <motion.span aria-hidden className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-white/15" animate={{ scale: [1, 1.25, 1], x: [0, -12, 0] }} transition={{ duration: 7, repeat: Infinity }} />
      <button type="button" onClick={onBack} className="relative mb-3 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white/20 px-3 py-1.5 text-xs font-semibold ring-1 ring-white/30" data-fx="own">
        <ArrowLeft size={14} /> Back
      </button>
      <div className="relative flex items-center gap-4">
        <motion.span initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }} className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/20 ring-1 ring-white/30">
          <motion.span animate={{ y: [0, -3, 0] }} transition={{ duration: 2.6, repeat: Infinity }}><Icon size={26} /></motion.span>
        </motion.span>
        <div className="min-w-0">
          <h3 className="truncate font-display text-xl font-bold tracking-[-0.02em] sm:text-2xl">{title}</h3>
          <p className="truncate text-xs text-white/80 sm:text-sm">{sub}</p>
        </div>
      </div>
      <div className="relative mt-4 grid grid-cols-3 gap-2 sm:max-w-md">
        {chips.map((c, i) => (
          <motion.div key={c.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.07 }} className="rounded-xl bg-white/15 px-3 py-2 ring-1 ring-white/25">
            <p className="text-[10px] uppercase tracking-wide text-white/70">{c.label}</p>
            <p className="truncate font-display text-base font-bold">{c.value}</p>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------- clinics ---
function ClinicsView({ status, onBack, onOpen, setStatus }: { status: ClinicStatus | 'all'; onBack: () => void; onOpen: (id: string) => void; setStatus: (s: ClinicStatus | 'all') => void }) {
  const [clinics, setClinics] = useState<ClinicRow[] | null>(null);
  const [doctors, setDoctors] = useState<DoctorRow[]>([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    (async () => {
      const [c, d] = await Promise.all([
        supabase.from('clinics').select('id, name, status, city, clinic_code, subscription_tier, is_active, is_verified, contact_phone, created_at').order('created_at', { ascending: false }),
        supabase.from('doctors').select('id, clinic_id, name, specialty, status, consultation_fee, is_active, is_verified'),
      ]);
      setClinics((c.data ?? []) as ClinicRow[]);
      setDoctors((d.data ?? []) as DoctorRow[]);
    })();
  }, []);

  const rows = useMemo(() => (clinics ?? []).filter((c) => (status === 'all' || c.status === status) && (!q || `${c.name} ${c.city ?? ''} ${c.clinic_code ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [clinics, status, q]);
  const doctorCount = (id: string) => doctors.filter((d) => d.clinic_id === id).length;

  const byStatus: ChartDatum[] = (['approved', 'pending', 'rejected', 'draft'] as const).map((s) => ({ label: cap(s), value: (clinics ?? []).filter((c) => c.status === s).length, color: STATUS_COLOR[s] }));
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5 - i));
    return { key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString(undefined, { month: 'short' }) };
  });
  const perMonth: ChartDatum[] = months.map((m) => ({ label: m.label, value: rows.filter((c) => { const d = new Date(c.created_at); return `${d.getFullYear()}-${d.getMonth()}` === m.key; }).length }));
  const perClinic: ChartDatum[] = rows.slice(0, 8).map((c) => ({ label: c.name, value: doctorCount(c.id) }));
  const title = status === 'all' ? 'All clinics' : `${cap(status)} clinics`;
  const [from, to] = status === 'approved' ? ['#059669', '#84cc16'] : status === 'pending' ? ['#f59e0b', '#f97316'] : status === 'rejected' ? ['#475569', '#94a3b8'] : ['#4f46e5', '#0ea5e9'];

  return (
    <div className="space-y-4">
      <Banner
        title={title}
        sub="Tap a clinic to see everything about it"
        icon={Building2}
        from={from}
        to={to}
        onBack={onBack}
        chips={[
          { label: 'Clinics', value: String(rows.length) },
          { label: 'Doctors', value: String(rows.reduce((n, c) => n + doctorCount(c.id), 0)) },
          { label: 'Live', value: String(rows.filter((c) => c.is_active && c.status === 'approved').length) },
        ]}
      />
      <div className="flex flex-wrap gap-2">
        {(['all', 'approved', 'pending', 'rejected'] as const).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)} data-fx="own" className={`cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${status === s ? 'bg-slate-900 text-white shadow-lg' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-slate-400'}`}>
            {cap(s)}
          </button>
        ))}
      </div>
      {clinics === null ? <p className="text-sm text-slate-400"><Loading /></p> : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="By status"><Donut data={byStatus} centre="clinics" /></Panel>
            <Panel title="Registered, last 6 months" delay={0.08}><Columns data={perMonth} color="#6366f1" /></Panel>
            <Panel title="Doctors per clinic" delay={0.16}>{perClinic.length ? <Bars data={perClinic} /> : <p className="text-sm text-slate-400">Nothing to chart.</p>}</Panel>
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-white px-3.5 py-3">
            <Search size={16} className="text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clinics by name, city or Clinic ID" className="w-full bg-transparent text-sm outline-none" />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <AnimatePresence initial={false}>
              {rows.map((c, i) => (
                <motion.button
                  key={c.id}
                  layout
                  type="button"
                  onClick={() => onOpen(c.id)}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ delay: Math.min(i, 8) * 0.04 }}
                  whileHover={{ y: -3 }}
                  data-fx="own"
                  className="group flex cursor-pointer items-center gap-3 rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm hover:shadow-lg"
                >
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: `linear-gradient(135deg, ${STATUS_COLOR[c.status]}, #0ea5e9)` }}>
                    <Building2 size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-bold text-slate-900">{c.name}</span>
                      {c.is_verified && <BadgeCheck size={15} className="shrink-0 text-emerald-500" />}
                    </span>
                    <span className="block truncate text-xs text-slate-500">{c.clinic_code ?? 'No Clinic ID yet'}{c.city ? ` · ${c.city}` : ''} · {doctorCount(c.id)} doctor{doctorCount(c.id) === 1 ? '' : 's'}</span>
                  </span>
                  <StatusPill label={c.status} tone={TONE[c.status]} />
                  <ChevronRight size={16} className="shrink-0 text-slate-300 transition group-hover:translate-x-1 group-hover:text-indigo-500" />
                </motion.button>
              ))}
            </AnimatePresence>
            {rows.length === 0 && <p className="text-sm text-slate-400">No clinics match.</p>}
          </div>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------- clinic detail ---
function ClinicDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [clinic, setClinic] = useState<Clinic | null | undefined>(undefined);
  const [doctors, setDoctors] = useState<DoctorRow[]>([]);
  const [appts, setAppts] = useState<{ id: string; date: string; status: string; payment_status: string }[]>([]);

  useEffect(() => {
    (async () => {
      const [c, d, a] = await Promise.all([
        supabase.from('clinics').select('*').eq('id', id).maybeSingle(),
        supabase.from('doctors').select('id, clinic_id, name, specialty, status, consultation_fee, is_active, is_verified').eq('clinic_id', id),
        supabase.from('appointments').select('id, date, status, payment_status').eq('clinic_id', id).order('date', { ascending: false }).limit(1000),
      ]);
      setClinic((c.data as Clinic | null) ?? null);
      setDoctors((d.data ?? []) as DoctorRow[]);
      setAppts((a.data ?? []) as typeof appts);
    })();
  }, [id]);

  if (clinic === undefined) return <p className="text-sm text-slate-400"><Loading /></p>;
  if (clinic === null) return <div><button type="button" onClick={onBack} className="text-sm font-semibold text-brand-600">Back</button><p className="mt-3 text-sm text-slate-500">Clinic not found.</p></div>;

  const statusCounts = Object.entries(appts.reduce<Record<string, number>>((m, a) => ({ ...m, [a.status]: (m[a.status] ?? 0) + 1 }), {})).map(([k, v]) => ({ label: cap(k), value: v, color: STATUS_COLOR[k] }));
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5 - i));
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString(undefined, { month: 'short' }) };
  });
  const perDay: ChartDatum[] = months.map((m) => ({ label: m.label, value: appts.filter((a) => a.date.startsWith(m.key)).length }));
  const paid = appts.filter((a) => a.payment_status === 'paid_online').length;
  const completed = appts.filter((a) => a.status === 'completed').length;
  const info: [typeof Phone, string, string | null][] = [
    [Phone, 'Phone', clinic.contact_phone], [Mail, 'Email', clinic.contact_email], [MapPin, 'Address', clinic.formatted_address ?? clinic.address],
    [BadgeCheck, 'Registration no.', clinic.reg_no], [CalendarCheck, 'Booking mode', clinic.mode], [Building2, 'Plan', clinic.subscription_tier],
  ];

  return (
    <div className="space-y-4">
      <Banner
        title={clinic.name}
        sub={`${clinic.clinic_code ?? 'No Clinic ID yet'}${clinic.city ? ` · ${clinic.city}` : ''}`}
        icon={Building2}
        from="#4f46e5" to="#0ea5e9"
        onBack={onBack}
        chips={[{ label: 'Doctors', value: String(doctors.length) }, { label: 'Bookings', value: String(appts.length) }, { label: 'Completed', value: String(completed) }]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill label={clinic.status} tone={TONE[clinic.status]} dot />
        <StatusPill label={clinic.is_active ? 'Active' : 'Inactive'} tone={clinic.is_active ? 'live' : 'neutral'} />
        {clinic.is_verified && <StatusPill label={`Verified${clinic.verified_at ? ` ${fmt(clinic.verified_at)}` : ''}`} tone="info" icon={BadgeCheck} />}
        <span className="text-xs text-slate-400">Registered {fmt(clinic.created_at)}</span>
      </div>
      {clinic.reject_reason && <p className="rounded-2xl bg-red-50 p-3 text-sm text-red-700">Rejected: {clinic.reject_reason}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Bookings by status">{statusCounts.length ? <Donut data={statusCounts} centre="bookings" /> : <p className="text-sm text-slate-400">No bookings yet.</p>}</Panel>
        <Panel title="Bookings per month, last 6 months" delay={0.08}><Columns data={perDay} color="#10b981" /></Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Details" delay={0.1}>
          <dl className="space-y-3">
            {info.map(([Icon, label, value], i) => (
              <motion.div key={label} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.05 }} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><Icon size={15} /></span>
                <span className="min-w-0"><dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt><dd className="break-words text-sm font-medium text-slate-800">{value || '-'}</dd></span>
              </motion.div>
            ))}
          </dl>
          <p className="mt-4 text-xs text-slate-500">{paid} paid online · {appts.length - paid} other payments</p>
        </Panel>
        <Panel title={`Doctors (${doctors.length})`} delay={0.16}>
          <div className="space-y-2">
            {doctors.length === 0 && <p className="text-sm text-slate-400">No doctors added.</p>}
            {doctors.map((d, i) => (
              <motion.div key={d.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.05 }} className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700"><Stethoscope size={16} /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{d.name}</span><span className="block truncate text-xs text-slate-500">{d.specialty ?? 'General'} · ₹{Number(d.consultation_fee).toLocaleString()}</span></span>
                <StatusPill label={d.status} tone={TONE[d.status]} />
              </motion.div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- doctors ---
function DoctorsView({ onBack, onOpenClinic }: { onBack: () => void; onOpenClinic: (id: string) => void }) {
  const [docs, setDocs] = useState<(DoctorRow & { clinics: { name: string } | null })[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    supabase.from('doctors').select('id, clinic_id, name, specialty, status, consultation_fee, is_active, is_verified, clinics(name)').then(({ data }) => setDocs((data ?? []) as unknown as typeof docs));
  }, []);
  const rows = (docs ?? []).filter((d) => !q || `${d.name} ${d.specialty ?? ''} ${d.clinics?.name ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const bySpec = Object.entries(rows.reduce<Record<string, number>>((m, d) => { const k = d.specialty || 'General'; m[k] = (m[k] ?? 0) + 1; return m; }, {})).map(([k, v]) => ({ label: k, value: v })).sort((a, b) => b.value - a.value).slice(0, 8);
  const byStatus = (['approved', 'pending', 'rejected', 'draft'] as const).map((s) => ({ label: cap(s), value: rows.filter((d) => d.status === s).length, color: STATUS_COLOR[s] }));
  return (
    <div className="space-y-4">
      <Banner title="All doctors" sub="Across every clinic" icon={Stethoscope} from="#0ea5e9" to="#14b8a6" onBack={onBack}
        chips={[{ label: 'Doctors', value: String(rows.length) }, { label: 'Approved', value: String(rows.filter((d) => d.status === 'approved').length) }, { label: 'Specialties', value: String(bySpec.length) }]} />
      {docs === null ? <p className="text-sm text-slate-400"><Loading /></p> : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="By specialty"><Bars data={bySpec} /></Panel>
            <Panel title="By status" delay={0.08}><Donut data={byStatus} centre="doctors" /></Panel>
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-white px-3.5 py-3"><Search size={16} className="text-slate-400" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search doctors, specialty or clinic" className="w-full bg-transparent text-sm outline-none" /></div>
          <div className="grid gap-3 md:grid-cols-2">
            {rows.map((d, i) => (
              <motion.button key={d.id} type="button" onClick={() => onOpenClinic(d.clinic_id)} data-fx="own" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.04 }} whileHover={{ y: -3 }} className="flex cursor-pointer items-center gap-3 rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm hover:shadow-lg">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-teal-400 text-white"><Stethoscope size={19} /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-slate-900">{d.name}</span><span className="block truncate text-xs text-slate-500">{d.specialty ?? 'General'} · {d.clinics?.name ?? 'Clinic'}</span></span>
                <StatusPill label={d.status} tone={TONE[d.status]} />
              </motion.button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------- appointments today ---
function TodayView({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<{ id: string; slot_time: string; status: string; clinics: { name: string } | null; doctors: { name: string } | null }[] | null>(null);
  useEffect(() => {
    supabase.from('appointments').select('id, slot_time, status, clinics(name), doctors(name)').eq('date', todayISO()).order('slot_time').then(({ data }) => setRows((data ?? []) as unknown as typeof rows));
  }, []);
  const data = Object.entries((rows ?? []).reduce<Record<string, number>>((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {})).map(([k, v]) => ({ label: cap(k), value: v, color: STATUS_COLOR[k] }));
  return (
    <div className="space-y-4">
      <Banner title="Appointments today" sub={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} icon={CalendarCheck} from="#6366f1" to="#ec4899" onBack={onBack}
        chips={[{ label: 'Total', value: String(rows?.length ?? 0) }, { label: 'Done', value: String((rows ?? []).filter((r) => r.status === 'completed').length) }, { label: 'Waiting', value: String((rows ?? []).filter((r) => ['booked', 'accepted', 'checked_in'].includes(r.status)).length) }]} />
      {rows === null ? <p className="text-sm text-slate-400"><Loading /></p> : rows.length === 0 ? (
        <Panel title="Today"><p className="text-sm text-slate-500">No appointments are booked for today.</p></Panel>
      ) : (
        <>
          <Panel title="By status"><Donut data={data} centre="today" /></Panel>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <motion.div key={r.id} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 10) * 0.04 }} className="flex items-center gap-3 rounded-2xl border border-slate-100 bg-white p-3">
                <span className="w-16 shrink-0 font-display text-sm font-bold text-indigo-600">{r.slot_time.slice(0, 5)}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{r.doctors?.name ?? 'Doctor'}</span><span className="block truncate text-xs text-slate-500">{r.clinics?.name}</span></span>
                <StatusPill label={cap(r.status)} tone={r.status === 'completed' ? 'live' : ['cancelled', 'rejected'].includes(r.status) ? 'danger' : r.status === 'booked' ? 'warning' : 'info'} />
              </motion.div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export const monthsBack = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (n - 1 - i));
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString(undefined, { month: 'short' }) };
  });

// ------------------------------------------------------------ fraud watch ---
function FraudDetail({ clinicId, onBack, onOpenClinic }: { clinicId: string; onBack: () => void; onOpenClinic: () => void }) {
  const [name, setName] = useState('Clinic');
  const [events, setEvents] = useState<{ id: string; date: string; status: string }[] | null>(null);
  const [refunds, setRefunds] = useState<{ id: string; amount: number; created_at: string }[]>([]);
  useEffect(() => {
    (async () => {
      const [c, a, r] = await Promise.all([
        supabase.from('clinics').select('name').eq('id', clinicId).maybeSingle(),
        supabase.from('appointments').select('id, date, status').eq('clinic_id', clinicId).in('status', ['rejected', 'no_show']).order('date', { ascending: false }).limit(500),
        supabase.from('payments').select('id, amount, created_at, appointments!inner(clinic_id)').eq('status', 'refunded').eq('appointments.clinic_id', clinicId).limit(500),
      ]);
      setName((c.data as { name: string } | null)?.name ?? 'Clinic');
      setEvents((a.data ?? []) as { id: string; date: string; status: string }[]);
      setRefunds((r.data ?? []) as unknown as { id: string; amount: number; created_at: string }[]);
    })();
  }, [clinicId]);
  const rej = (events ?? []).filter((e) => e.status === 'rejected').length;
  const ns = (events ?? []).filter((e) => e.status === 'no_show').length;
  const ref = refunds.length;
  const T = FRAUD_THRESHOLDS;
  const flagged = rej >= T.rejections || ns >= T.noShows || ref >= T.refunds;
  const months = monthsBack(6);
  return (
    <div className="space-y-4">
      <Banner title={name} sub={flagged ? 'Over a review threshold' : 'Within the usual range'} icon={ShieldAlert} from={flagged ? '#e11d48' : '#10b981'} to={flagged ? '#f97316' : '#0ea5e9'} onBack={onBack}
        chips={[{ label: 'Rejections', value: String(rej) }, { label: 'No-shows', value: String(ns) }, { label: 'Refunds', value: String(ref) }]} />
      {events === null ? <p className="text-sm text-slate-400"><Loading /></p> : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Against the review limits">
              <Bars data={[
                { label: `Rejections (limit ${T.rejections})`, value: rej, color: rej >= T.rejections ? '#f43f5e' : '#6366f1' },
                { label: `No-shows (limit ${T.noShows})`, value: ns, color: ns >= T.noShows ? '#f43f5e' : '#f59e0b' },
                { label: `Refunds (limit ${T.refunds})`, value: ref, color: ref >= T.refunds ? '#f43f5e' : '#8b5cf6' },
              ]} />
              <div className="mt-3"><StatusPill label={flagged ? 'Flagged' : 'Not flagged'} tone={flagged ? 'warning' : 'live'} dot /></div>
            </Panel>
            <Panel title="Problem bookings per month" delay={0.08}>
              <Columns color="#f43f5e" data={months.map((m) => ({ label: m.label, value: (events ?? []).filter((e) => e.date.startsWith(m.key)).length }))} />
            </Panel>
          </div>
          <Panel title="Most recent problem bookings" delay={0.12}>
            <div className="space-y-2">
              {(events ?? []).slice(0, 10).map((e, i) => (
                <motion.div key={e.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                  <span className="text-sm text-slate-700">{fmt(e.date)}</span>
                  <StatusPill label={cap(e.status)} tone={e.status === 'rejected' ? 'danger' : 'neutral'} />
                </motion.div>
              ))}
              {events.length === 0 && <p className="text-sm text-slate-400">None recorded.</p>}
            </div>
          </Panel>
          <button type="button" onClick={onOpenClinic} className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-brand-600">Open the clinic <ChevronRight size={15} /></button>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------- payment detail ---
interface PayFull {
  id: string; amount: number; gross_amount: number | null; discount_amount: number; coupon_code: string | null; method: string; status: string;
  payout_status: string; created_at: string; razorpay_payment_id: string | null;
  appointments: { clinic_id: string; date: string; slot_time: string; status: string; clinics: { name: string } | null; doctors: { name: string } | null; family_members: { name: string } | null } | null;
}
function PaymentDetail({ id, onBack, onOpenClinic }: { id: string; onBack: () => void; onOpenClinic: (id: string) => void }) {
  const [pay, setPay] = useState<PayFull | null | undefined>(undefined);
  const [others, setOthers] = useState<{ status: string; amount: number; created_at: string }[]>([]);
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('payments').select('id, amount, gross_amount, discount_amount, coupon_code, method, status, payout_status, created_at, razorpay_payment_id, appointments(clinic_id, date, slot_time, status, clinics(name), doctors(name), family_members(name))').eq('id', id).maybeSingle();
      const row = (data as unknown as PayFull | null) ?? null;
      setPay(row);
      if (row?.appointments?.clinic_id) {
        const { data: o } = await supabase.from('payments').select('status, amount, created_at, appointments!inner(clinic_id)').eq('appointments.clinic_id', row.appointments.clinic_id).limit(500);
        setOthers((o ?? []) as unknown as typeof others);
      }
    })();
  }, [id]);
  if (pay === undefined) return <p className="text-sm text-slate-400"><Loading /></p>;
  if (pay === null) return <div><button type="button" onClick={onBack} className="text-sm font-semibold text-brand-600">Back</button><p className="mt-3 text-sm text-slate-500">Payment not found.</p></div>;
  const a = pay.appointments;
  const mix = Object.entries(others.reduce<Record<string, number>>((m, p) => { m[p.status] = (m[p.status] ?? 0) + 1; return m; }, {})).map(([k, v]) => ({ label: cap(k), value: v, color: k === 'captured' ? '#10b981' : k === 'refunded' ? '#8b5cf6' : k === 'hold' ? '#f43f5e' : '#f59e0b' }));
  const months = monthsBack(6);
  const rows: [string, string][] = [
    ['Clinic', a?.clinics?.name ?? '-'], ['Doctor', a?.doctors?.name ?? '-'], ['Patient', a?.family_members?.name ?? '-'],
    ['Visit', a ? `${fmt(a.date)} at ${a.slot_time.slice(0, 5)}` : '-'], ['Visit status', a ? cap(a.status) : '-'], ['Method', pay.method === 'online' ? 'Paid online' : 'Cash at clinic'],
    ['Payout', cap(pay.payout_status)], ['Recorded', fmt(pay.created_at)],
    ...(pay.coupon_code ? [['Coupon', `${pay.coupon_code}: ₹${pay.gross_amount ?? pay.amount} to ₹${pay.amount} (-₹${pay.discount_amount})`] as [string, string]] : []),
    ...(pay.razorpay_payment_id ? [['Razorpay id', pay.razorpay_payment_id] as [string, string]] : []),
  ];
  return (
    <div className="space-y-4">
      <Banner title={`₹${Number(pay.amount).toLocaleString()}`} sub={`${a?.clinics?.name ?? 'Clinic'} · ${pay.method}`} icon={IndianRupee} from={pay.status === 'refunded' ? '#8b5cf6' : pay.status === 'captured' ? '#059669' : '#f59e0b'} to="#0ea5e9" onBack={onBack}
        chips={[{ label: 'Status', value: cap(pay.status) }, { label: 'Method', value: pay.method }, { label: 'Payout', value: cap(pay.payout_status) }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Details">
          <dl className="space-y-2.5">
            {rows.map(([k, v], i) => (
              <motion.div key={k} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }} className="flex items-start justify-between gap-4 border-b border-slate-50 pb-2 last:border-0">
                <dt className="text-xs uppercase tracking-wide text-slate-400">{k}</dt>
                <dd className="break-all text-right text-sm font-medium text-slate-800">{v}</dd>
              </motion.div>
            ))}
          </dl>
          {a?.clinic_id !== undefined && <button type="button" onClick={() => onOpenClinic(a.clinic_id)} className="mt-3 inline-flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-brand-600">Open the clinic <ChevronRight size={15} /></button>}
        </Panel>
        <div className="space-y-4">
          <Panel title="This clinic's payments by status" delay={0.08}>{mix.length ? <Donut data={mix} centre="payments" /> : <p className="text-sm text-slate-400">No data.</p>}</Panel>
          <Panel title="This clinic's payments per month" delay={0.14}><Columns color="#10b981" data={months.map((m) => ({ label: m.label, value: others.filter((o) => o.created_at.startsWith(m.key)).length }))} /></Panel>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- payout account ---
function PayoutDetail({ clinicId, onBack, onOpenClinic }: { clinicId: string; onBack: () => void; onOpenClinic: () => void }) {
  const [clinic, setClinic] = useState<{ name: string; contact_email: string | null; contact_phone: string | null; razorpay_fund_account_id: string | null; razorpay_account_status: string; razorpay_account_note: string | null } | null | undefined>(undefined);
  const [sets, setSets] = useState<{ status: string; net_amount: number; platform_fee: number; net_payout: number | null; created_at: string }[]>([]);
  useEffect(() => {
    (async () => {
      const [c, st] = await Promise.all([
        supabase.from('clinics').select('name, contact_email, contact_phone, razorpay_fund_account_id, razorpay_account_status, razorpay_account_note').eq('id', clinicId).maybeSingle(),
        supabase.from('settlements').select('status, net_amount, platform_fee, net_payout, created_at').eq('clinic_id', clinicId).limit(500),
      ]);
      setClinic((c.data as typeof clinic) ?? null);
      setSets((st.data ?? []) as typeof sets);
    })();
  }, [clinicId]);
  if (clinic === undefined) return <p className="text-sm text-slate-400"><Loading /></p>;
  if (clinic === null) return <div><button type="button" onClick={onBack} className="text-sm font-semibold text-brand-600">Back</button><p className="mt-3 text-sm text-slate-500">Clinic not found.</p></div>;
  const sum = (f: (r: (typeof sets)[number]) => number) => sets.reduce((n, r) => n + f(r), 0);
  const byStatus = Object.entries(sets.reduce<Record<string, number>>((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {})).map(([k, v]) => ({ label: cap(k), value: v }));
  const months = monthsBack(6);
  const activated = clinic.razorpay_account_status === 'activated';
  return (
    <div className="space-y-4">
      <Banner title={clinic.name} sub={activated ? 'Payout account active' : 'Payout account not active yet'} icon={Banknote} from={activated ? '#059669' : '#475569'} to={activated ? '#84cc16' : '#0ea5e9'} onBack={onBack}
        chips={[{ label: 'Settlements', value: String(sets.length) }, { label: 'Net', value: `₹${Math.round(sum((r) => Number(r.net_amount))).toLocaleString()}` }, { label: 'Fees', value: `₹${Math.round(sum((r) => Number(r.platform_fee))).toLocaleString()}` }]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Account">
          <div className="mb-3 flex flex-wrap items-center gap-2"><StatusPill label={cap(clinic.razorpay_account_status)} tone={activated ? 'live' : 'warning'} dot /></div>
          <dl className="space-y-2.5 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-slate-400">Email</dt><dd className="text-slate-800">{clinic.contact_email ?? '-'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-slate-400">Phone</dt><dd className="text-slate-800">{clinic.contact_phone ?? '-'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-slate-400">Razorpay account</dt><dd className="break-all font-mono text-xs text-slate-800">{clinic.razorpay_fund_account_id ?? 'Not created'}</dd></div>
          </dl>
          {clinic.razorpay_account_note && <p className="mt-3 rounded-xl bg-red-50 p-2 text-xs text-red-700">{clinic.razorpay_account_note}</p>}
          <button type="button" onClick={onOpenClinic} className="mt-3 inline-flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-brand-600">Open the clinic <ChevronRight size={15} /></button>
        </Panel>
        <Panel title="Settlements by status" delay={0.08}>{byStatus.length ? <Donut data={byStatus} centre="settlements" /> : <p className="text-sm text-slate-400">No settlements yet.</p>}</Panel>
      </div>
      <Panel title="Net earned per month" delay={0.14}><Columns color="#10b981" data={months.map((m) => ({ label: m.label, value: Math.round(sets.filter((r) => r.created_at.startsWith(m.key)).reduce((n, r) => n + Number(r.net_amount), 0)) }))} /></Panel>
    </div>
  );
}

// ----------------------------------------------------------- doctor detail ---
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function DoctorDetail({ id, onBack, onOpenClinic }: { id: string; onBack: () => void; onOpenClinic: (id: string) => void }) {
  const [doc, setDoc] = useState<(DoctorRow & { reg_no: string | null; reject_reason: string | null; created_at: string; clinics: { name: string } | null }) | null | undefined>(undefined);
  const [appts, setAppts] = useState<{ date: string; status: string }[]>([]);
  const [avail, setAvail] = useState<{ weekday: number; start_time: string; end_time: string; max_patients_per_day: number }[]>([]);
  useEffect(() => {
    (async () => {
      const [d, a, v] = await Promise.all([
        supabase.from('doctors').select('id, clinic_id, name, specialty, status, consultation_fee, is_active, is_verified, reg_no, reject_reason, created_at, clinics(name)').eq('id', id).maybeSingle(),
        supabase.from('appointments').select('date, status').eq('doctor_id', id).limit(2000),
        supabase.from('doctor_availability').select('weekday, start_time, end_time, max_patients_per_day').eq('doctor_id', id).order('weekday'),
      ]);
      setDoc((d.data as unknown as typeof doc) ?? null);
      setAppts((a.data ?? []) as typeof appts);
      setAvail((v.data ?? []) as typeof avail);
    })();
  }, [id]);
  if (doc === undefined) return <p className="text-sm text-slate-400"><Loading /></p>;
  if (doc === null) return <div><button type="button" onClick={onBack} className="text-sm font-semibold text-brand-600">Back</button><p className="mt-3 text-sm text-slate-500">Doctor not found.</p></div>;
  const months = monthsBack(6);
  const outcome = Object.entries(appts.reduce<Record<string, number>>((m, a) => { m[a.status] = (m[a.status] ?? 0) + 1; return m; }, {})).map(([k, v]) => ({ label: cap(k), value: v, color: STATUS_COLOR[k] }));
  return (
    <div className="space-y-4">
      <Banner title={doc.name} sub={`${doc.specialty ?? 'General'} · ${doc.clinics?.name ?? 'Clinic'}`} icon={Stethoscope} from="#0ea5e9" to="#14b8a6" onBack={onBack}
        chips={[{ label: 'Fee', value: `₹${Number(doc.consultation_fee).toLocaleString()}` }, { label: 'Bookings', value: String(appts.length) }, { label: 'Completed', value: String(appts.filter((a) => a.status === 'completed').length) }]} />
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill label={doc.status} tone={TONE[doc.status]} dot />
        <StatusPill label={doc.is_verified ? 'Verified' : 'Not verified'} tone={doc.is_verified ? 'live' : 'neutral'} icon={BadgeCheck} />
        <StatusPill label={doc.is_active ? 'Working here' : 'Removed'} tone={doc.is_active ? 'live' : 'neutral'} />
        <span className="text-xs text-slate-400">Added {fmt(doc.created_at)} · Reg. {doc.reg_no ?? '-'}</span>
      </div>
      {doc.reject_reason && <p className="rounded-2xl bg-red-50 p-3 text-sm text-red-700">Rejected: {doc.reject_reason}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Outcomes">{outcome.length ? <Donut data={outcome} centre="bookings" /> : <p className="text-sm text-slate-400">No bookings yet.</p>}</Panel>
        <Panel title="Bookings per month" delay={0.08}><Columns color="#0ea5e9" data={months.map((m) => ({ label: m.label, value: appts.filter((a) => a.date.startsWith(m.key)).length }))} /></Panel>
      </div>
      <Panel title="Weekly schedule" delay={0.12}>
        {avail.length === 0 ? <p className="text-sm text-slate-400">No availability set.</p> : (
          <div className="space-y-2">
            {avail.map((w, i) => (
              <motion.div key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                <span className="font-semibold text-slate-800">{DAYS[w.weekday]}</span>
                <span className="text-slate-500">{w.start_time.slice(0, 5)} to {w.end_time.slice(0, 5)}</span>
                <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-[11px] font-bold text-sky-700">up to {w.max_patients_per_day}/day</span>
              </motion.div>
            ))}
          </div>
        )}
      </Panel>
      <button type="button" onClick={() => onOpenClinic(doc.clinic_id)} className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-brand-600">Open the clinic <ChevronRight size={15} /></button>
    </div>
  );
}

// ------------------------------------------------------- settlement detail ---
const STAGES = ['collected', 'eligible', 'released', 'settled'];
function SettlementDetail({ id, onBack, onOpenPayout }: { id: string; onBack: () => void; onOpenPayout: (clinicId: string) => void }) {
  const [r, setR] = useState<{ clinic_id: string; status: string; net_amount: number; platform_fee: number; commission_rate: number; net_payout: number | null; hold_reason: string | null; released_at: string | null; settled_at: string | null; created_at: string; payout_reference: string | null; razorpay_transfer_id: string | null; clinics: { name: string } | null; appointments: { date: string; slot_time: string; family_members: { name: string } | null } | null } | null | undefined>(undefined);
  useEffect(() => {
    supabase.from('settlements').select('clinic_id, status, net_amount, platform_fee, commission_rate, net_payout, hold_reason, released_at, settled_at, created_at, payout_reference, razorpay_transfer_id, clinics(name), appointments(date, slot_time, family_members(name))').eq('id', id).maybeSingle().then(({ data }) => setR((data as unknown as typeof r) ?? null));
  }, [id]);
  if (r === undefined) return <p className="text-sm text-slate-400"><Loading /></p>;
  if (r === null) return <div><button type="button" onClick={onBack} className="text-sm font-semibold text-brand-600">Back</button><p className="mt-3 text-sm text-slate-500">Settlement not found.</p></div>;
  const net = Number(r.net_amount) - Number(r.platform_fee);
  const stage = STAGES.indexOf(r.status);
  const details: [string, string][] = [['Patient', r.appointments?.family_members?.name ?? '-'], ['Visit', r.appointments ? `${fmt(r.appointments.date)} at ${r.appointments.slot_time.slice(0, 5)}` : '-'], ['Created', fmt(r.created_at)], ['Released', r.released_at ? fmt(r.released_at) : '-'], ['Settled', r.settled_at ? fmt(r.settled_at) : '-'], ['Reference', r.payout_reference ?? r.razorpay_transfer_id ?? '-']];
  return (
    <div className="space-y-4">
      <Banner title={`₹${Math.round(net).toLocaleString()} to the clinic`} sub={`${r.clinics?.name ?? 'Clinic'} · ${r.appointments ? fmt(r.appointments.date) : ''}`} icon={Banknote} from="#059669" to="#0ea5e9" onBack={onBack}
        chips={[{ label: 'Collected', value: `₹${Number(r.net_amount).toLocaleString()}` }, { label: 'Fee', value: `₹${Number(r.platform_fee).toLocaleString()}` }, { label: 'Rate', value: `${(Number(r.commission_rate) * 100).toFixed(1)}%` }]} />
      <Panel title="Where it is">
        <div className="flex items-center">
          {STAGES.map((s, i) => (
            <div key={s} className="flex flex-1 items-center">
              <div className="flex flex-col items-center gap-1">
                <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: i * 0.12, type: 'spring' }} className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white ${i <= stage ? 'bg-gradient-to-br from-emerald-500 to-teal-500 shadow-lg' : 'bg-slate-300'}`}>{i + 1}</motion.span>
                <span className="text-[11px] font-medium text-slate-600">{cap(s)}</span>
              </div>
              {i < STAGES.length - 1 && <motion.span initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: 0.1 + i * 0.12 }} className={`mx-1 mb-5 h-1 flex-1 origin-left rounded-full ${i < stage ? 'bg-emerald-400' : 'bg-slate-200'}`} />}
            </div>
          ))}
        </div>
        {r.status === 'on_hold' && <p className="mt-3 rounded-xl bg-amber-50 p-2 text-xs text-amber-800">On hold: {r.hold_reason ?? 'no reason given'}</p>}
        {r.status === 'refunded' && <p className="mt-3 rounded-xl bg-violet-50 p-2 text-xs text-violet-800">This payment was refunded.</p>}
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Money split" delay={0.08}>
          <Bars data={[{ label: 'Collected', value: Math.round(Number(r.net_amount)), color: '#6366f1' }, { label: 'Platform fee', value: Math.round(Number(r.platform_fee)), color: '#f59e0b' }, { label: 'To the clinic', value: Math.round(net), color: '#10b981' }]} />
        </Panel>
        <Panel title="Details" delay={0.12}>
          <dl className="space-y-2 text-sm">
            {details.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 border-b border-slate-50 pb-1.5 last:border-0"><dt className="text-slate-400">{k}</dt><dd className="break-all text-right font-medium text-slate-800">{v}</dd></div>
            ))}
          </dl>
          <button type="button" onClick={() => onOpenPayout(r.clinic_id)} className="mt-3 inline-flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-brand-600">All of this clinic's settlements <ChevronRight size={15} /></button>
        </Panel>
      </div>
    </div>
  );
}

export default function AdminDrill({ view, onChange, onClose }: { view: DrillView; onChange: (v: DrillView) => void; onClose: () => void }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={view.kind + ('id' in view ? view.id : '')} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
        {view.kind === 'clinics' && <ClinicsView status={view.status} onBack={onClose} setStatus={(s) => onChange({ kind: 'clinics', status: s })} onOpen={(id) => onChange({ kind: 'clinic', id, from: view.status })} />}
        {view.kind === 'clinic' && <ClinicDetail id={view.id} onBack={() => (view.from === 'close' ? onClose() : onChange({ kind: 'clinics', status: view.from }))} />}
        {view.kind === 'fraud' && <FraudDetail clinicId={view.clinicId} onBack={onClose} onOpenClinic={() => onChange({ kind: 'clinic', id: view.clinicId, from: 'close' })} />}
        {view.kind === 'payment' && <PaymentDetail id={view.id} onBack={onClose} onOpenClinic={(id) => onChange({ kind: 'clinic', id, from: 'close' })} />}
        {view.kind === 'doctor' && <DoctorDetail id={view.id} onBack={onClose} onOpenClinic={(id) => onChange({ kind: 'clinic', id, from: 'close' })} />}
        {view.kind === 'settlement' && <SettlementDetail id={view.id} onBack={onClose} onOpenPayout={(clinicId) => onChange({ kind: 'payout', clinicId })} />}
        {view.kind === 'payout' && <PayoutDetail clinicId={view.clinicId} onBack={onClose} onOpenClinic={() => onChange({ kind: 'clinic', id: view.clinicId, from: 'close' })} />}
        {view.kind === 'doctors' && <DoctorsView onBack={onClose} onOpenClinic={(id) => onChange({ kind: 'clinic', id, from: 'all' })} />}
        {view.kind === 'today' && <TodayView onBack={onClose} />}
      </motion.div>
    </AnimatePresence>
  );
}
