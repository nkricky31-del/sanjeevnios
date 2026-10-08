import { ArrowLeft, BadgeCheck, Building2, CalendarCheck, ChevronRight, Mail, MapPin, Phone, Search, Stethoscope } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { todayISO } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import type { Clinic, ClinicStatus } from '../lib/types';
import { Bars, Columns, Donut, type ChartDatum } from './ui/MiniCharts';
import Loading from './ui/Loading';
import StatusPill from './ui/StatusPill';

export type DrillView =
  | { kind: 'clinics'; status: ClinicStatus | 'all' }
  | { kind: 'clinic'; id: string; from: ClinicStatus | 'all' }
  | { kind: 'doctors' }
  | { kind: 'today' };

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

function Panel({ title, children, delay = 0 }: { title: string; children: ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.45 }}
      className="rounded-2xl border border-slate-100 bg-white p-4"
    >
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{title}</p>
      {children}
    </motion.div>
  );
}

function Banner({ title, sub, icon: Icon, from, to, onBack, chips }: {
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

export default function AdminDrill({ view, onChange, onClose }: { view: DrillView; onChange: (v: DrillView) => void; onClose: () => void }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={view.kind + ('id' in view ? view.id : '')} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
        {view.kind === 'clinics' && <ClinicsView status={view.status} onBack={onClose} setStatus={(s) => onChange({ kind: 'clinics', status: s })} onOpen={(id) => onChange({ kind: 'clinic', id, from: view.status })} />}
        {view.kind === 'clinic' && <ClinicDetail id={view.id} onBack={() => onChange({ kind: 'clinics', status: view.from })} />}
        {view.kind === 'doctors' && <DoctorsView onBack={onClose} onOpenClinic={(id) => onChange({ kind: 'clinic', id, from: 'all' })} />}
        {view.kind === 'today' && <TodayView onBack={onClose} />}
      </motion.div>
    </AnimatePresence>
  );
}
