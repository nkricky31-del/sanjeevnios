import { ArrowLeft, ChevronDown, Download, ExternalLink, FileText, FlaskConical, Pill, ScanLine, UploadCloud, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';

import FileUpload from '../components/FileUpload';
import HeroBand from '../components/ui/HeroBand';
import Loading from '../components/ui/Loading';
import { downloadPrescriptionText } from '../lib/encounterExport';
import { downloadAppointmentFile, openAppointmentFile } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentFile, FamilyMember, FileCategory, Prescription } from '../lib/types';

type CategoryKey = 'encounters' | 'prescriptions' | 'lab_report' | 'xray' | 'documents';

interface Appt {
  id: string;
  member_id: string;
  date: string;
  slot_time: string;
  doctors: { name: string; specialty: string | null } | null;
  clinics: { name: string } | null;
  visits: { id: string; diagnosis: string | null; notes: string | null; prescriptions: Prescription[] }[];
  files: AppointmentFile[];
}

interface Enc {
  id: string;
  encounter_no: string;
  visit_datetime: string;
  department: string | null;
  doctors: { name: string } | null;
  clinics: { name: string } | null;
}

const META: Record<
  CategoryKey,
  { label: string; blurb: string; Icon: LucideIcon; from: string; to: string; upload?: { type: FileCategory; label: string } }
> = {
  encounters: { label: 'Encounters & Visit Summary', blurb: 'Every doctor visit, in order, with its notes and summary.', Icon: FileText, from: '#6366f1', to: '#38bdf8' },
  prescriptions: { label: 'Prescriptions', blurb: 'Every medicine you have been prescribed, with dose, timing and how long.', Icon: Pill, from: '#10b981', to: '#a3e635', upload: { type: 'prescription', label: 'Upload a prescription' } },
  lab_report: { label: 'Lab Reports', blurb: 'Blood tests, urine tests and more.', Icon: FlaskConical, from: '#0ea5e9', to: '#14b8a6', upload: { type: 'lab_report', label: 'Upload a lab report' } },
  xray: { label: 'Imaging & Radiology', blurb: 'X-rays, MRI, CT scans and more.', Icon: ScanLine, from: '#f59e0b', to: '#f43f5e', upload: { type: 'xray', label: 'Upload a scan' } },
  documents: { label: 'Medical Documents', blurb: 'Photos and other documents you have uploaded.', Icon: FileText, from: '#ec4899', to: '#8b5cf6', upload: { type: 'photo', label: 'Upload a document' } },
};

const KEYS = Object.keys(META) as CategoryKey[];
const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

// A real page for each kind of record: a coloured banner with the numbers, then
// the records themselves - with the actions that make sense for them (open the
// visit, read the medicines, view or download a file, upload a new one).
export default function RecordsCategory() {
  const { category } = useParams<{ category: string }>();
  const navigate = useNavigate();
  const key = category as CategoryKey;
  const valid = KEYS.includes(key);

  const [appts, setAppts] = useState<Appt[]>([]);
  const [encs, setEncs] = useState<Enc[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFor, setUploadFor] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: m } = await supabase.from('family_members').select('*');
    const mem = (m ?? []) as FamilyMember[];
    setMembers(mem);
    const ids = mem.map((x) => x.id);
    const mrns = mem.map((x) => x.mrn).filter(Boolean);
    const [a, e] = await Promise.all([
      ids.length
        ? supabase
            .from('appointments')
            .select(
              'id, member_id, date, slot_time, doctors(name, specialty), clinics(name), visits(id, notes:notes_plain, diagnosis:diagnosis_plain, prescriptions(id, visit_id, items, file_url, signed_by, status, created_at)), files(id, member_id, appointment_id, type, storage_path, created_at)'
            )
            .in('member_id', ids)
            .order('date', { ascending: false })
        : Promise.resolve({ data: [] }),
      mrns.length
        ? supabase
            .from('encounters')
            .select('id, encounter_no, visit_datetime, department, doctors(name), clinics(name)')
            .in('mrn', mrns)
            .order('visit_datetime', { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);
    const list = (a.data ?? []) as unknown as Appt[];
    setAppts(list);
    setEncs((e.data ?? []) as unknown as Enc[]);
    setUploadFor((cur) => cur || list[0]?.id || '');
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const meta = valid ? META[key] : META.encounters;

  const rx = useMemo(
    () =>
      appts.flatMap((a) =>
        a.visits.flatMap((v) => (v.prescriptions ?? []).map((p) => ({ p, a, diagnosis: v.diagnosis }))),
      ),
    [appts],
  );

  const files = useMemo(() => {
    const wanted = (f: AppointmentFile) =>
      key === 'lab_report' ? f.type === 'lab_report'
      : key === 'xray' ? f.type === 'xray'
      : key === 'prescriptions' ? f.type === 'prescription'
      : f.type !== 'lab_report' && f.type !== 'xray';
    return appts.flatMap((a) => a.files.filter(wanted).map((f) => ({ f, a }))).sort((x, y) => y.f.created_at.localeCompare(x.f.created_at));
  }, [appts, key]);

  if (!valid) return <Navigate to="/records" replace />;

  const total = key === 'encounters' ? encs.length : key === 'prescriptions' ? rx.length + files.length : files.length;
  const latest =
    key === 'encounters' ? encs[0]?.visit_datetime : key === 'prescriptions' ? rx[0]?.p.created_at ?? files[0]?.f.created_at : files[0]?.f.created_at;
  const medicineCount = key === 'prescriptions' ? rx.reduce((n, r) => n + (r.p.items?.length ?? 0), 0) : 0;
  const doctors = new Set(
    key === 'encounters' ? encs.map((e) => e.doctors?.name) : [...rx.map((r) => r.a.doctors?.name), ...files.map((x) => x.a.doctors?.name)],
  );
  doctors.delete(undefined);

  const chips: { label: string; value: string }[] = [
    { label: key === 'encounters' ? 'Visits' : 'Records', value: String(total) },
    ...(key === 'prescriptions' ? [{ label: 'Medicines', value: String(medicineCount) }] : []),
    { label: 'Doctors', value: String(doctors.size) },
    { label: 'Latest', value: latest ? fmt(latest) : '-' },
  ];

  const apptFor = appts.find((a) => a.id === uploadFor);

  const act = async (fn: () => Promise<{ error: string } | object>) => {
    setMsg(null);
    const r = await fn();
    if ('error' in r) setMsg(String((r as { error: string }).error));
  };

  return (
    <div>
      <HeroBand>
        <button
          type="button"
          onClick={() => navigate('/records')}
          className="mb-4 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/25 backdrop-blur"
        >
          <ArrowLeft size={14} /> Records
        </button>
        <div className="flex items-center gap-4">
          <motion.span
            className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-3xl text-white shadow-2xl"
            style={{ background: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}
            initial={{ scale: 0, rotate: -30 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 14 }}
          >
            <motion.span
              aria-hidden
              className="absolute inset-0 rounded-3xl"
              style={{ background: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}
              animate={{ scale: [1, 1.5], opacity: [0.5, 0] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: 'easeOut' }}
            />
            <motion.span className="relative" animate={{ y: [0, -4, 0], rotate: [0, -6, 6, 0] }} transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}>
              <meta.Icon size={30} />
            </motion.span>
          </motion.span>
          <div className="min-w-0">
            <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
              {meta.label}
            </motion.h1>
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }} className="mt-1 text-xs text-white/75 sm:text-sm">
              {meta.blurb}
            </motion.p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2 sm:max-w-xl">
          {chips.slice(0, 3).map((c, i) => (
            <motion.div
              key={c.label}
              className="rounded-2xl bg-white/12 px-3 py-2.5 ring-1 ring-white/20 backdrop-blur"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 + i * 0.08 }}
            >
              <p className="text-[10px] uppercase tracking-[0.12em] text-white/70">{c.label}</p>
              <p className="mt-0.5 truncate font-display text-lg font-bold">{c.value}</p>
            </motion.div>
          ))}
        </div>
      </HeroBand>

      <div className="px-4 pb-8">
        {meta.upload && (
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setShowUpload((s) => !s)}
              className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-2xl p-4 text-left text-white shadow-lg"
              style={{ background: `linear-gradient(110deg, ${meta.from}, ${meta.to})` }}
              data-fx="own"
            >
              <span className="flex items-center gap-3">
                <motion.span animate={{ y: [0, -4, 0] }} transition={{ duration: 2, repeat: Infinity }}>
                  <UploadCloud size={24} />
                </motion.span>
                <span>
                  <span className="block text-sm font-bold">{meta.upload.label}</span>
                  <span className="block text-xs text-white/80">JPG, PNG or PDF, up to 10 MB, attached to one of your visits.</span>
                </span>
              </span>
              <motion.span animate={{ rotate: showUpload ? 180 : 0 }}><ChevronDown size={20} /></motion.span>
            </button>
            <AnimatePresence initial={false}>
              {showUpload && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  {appts.length === 0 ? (
                    <p className="mt-3 rounded-2xl bg-amber-50 p-3 text-sm text-amber-800">
                      Files are attached to a visit. Book an appointment first, then you can add files to it.
                    </p>
                  ) : (
                    <div className="mt-3">
                      <label className="text-xs font-semibold text-slate-500" htmlFor="rc-appt">Attach to visit</label>
                      <select
                        id="rc-appt"
                        value={uploadFor}
                        onChange={(e) => setUploadFor(e.target.value)}
                        className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm"
                      >
                        {appts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {fmt(a.date)} · {a.doctors?.name ?? 'Doctor'}
                            {a.clinics?.name ? ` · ${a.clinics.name}` : ''}
                          </option>
                        ))}
                      </select>
                      {apptFor && (
                        <FileUpload
                          key={apptFor.id + meta.upload.type}
                          appointmentId={apptFor.id}
                          memberId={apptFor.member_id}
                          fixedCategory={meta.upload.type}
                          hideList
                          onUploaded={() => void load()}
                        />
                      )}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {msg && <p className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{msg}</p>}
        {loading && <p className="py-8 text-center text-sm text-slate-400"><Loading /></p>}

        {!loading && total === 0 && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="rounded-3xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
            <motion.span
              className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl text-white"
              style={{ background: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}
              animate={{ y: [0, -8, 0] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
            >
              <meta.Icon size={28} />
            </motion.span>
            <p className="mt-4 font-display text-lg font-bold text-slate-900">Nothing here yet</p>
            <p className="mt-1 text-sm text-slate-500">
              {key === 'encounters' ? 'Your visit summaries appear here once a doctor has seen you.' : meta.upload ? 'Add one with the button above, or it will appear after a visit.' : 'It will appear after a visit.'}
            </p>
          </motion.div>
        )}

        {/* encounters: a timeline */}
        {key === 'encounters' && encs.length > 0 && (
          <ol className="relative ml-3 space-y-3 border-l-2 border-dashed border-indigo-200 pl-5">
            {encs.map((e, i) => (
              <motion.li key={e.id} initial={{ opacity: 0, x: -18 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 8) * 0.06 }} className="relative">
                <motion.span
                  className="absolute -left-[1.85rem] top-5 h-3.5 w-3.5 rounded-full ring-4 ring-white"
                  style={{ background: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}
                  animate={{ scale: [1, 1.3, 1] }}
                  transition={{ duration: 2, delay: i * 0.2, repeat: Infinity }}
                />
                <button
                  type="button"
                  onClick={() => navigate(`/encounters/${e.id}`)}
                  className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg"
                  data-fx="own"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-[11px] font-bold text-indigo-600">{e.encounter_no}</span>
                    <span className="block truncate text-sm font-bold text-slate-900">{e.doctors?.name ?? 'Doctor'}{e.department ? ` · ${e.department}` : ''}</span>
                    <span className="block truncate text-xs text-slate-500">{fmt(e.visit_datetime)}{e.clinics?.name ? ` · ${e.clinics.name}` : ''}</span>
                  </span>
                  <ExternalLink size={16} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500" />
                </button>
              </motion.li>
            ))}
          </ol>
        )}

        {/* prescriptions: expandable cards with the medicines */}
        {key === 'prescriptions' && rx.length > 0 && (
          <div className="space-y-3">
            {rx.map(({ p, a, diagnosis }, i) => {
              const isOpen = open === p.id;
              return (
                <motion.div
                  key={p.id}
                  layout
                  initial={{ opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i, 8) * 0.06 }}
                  className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm"
                >
                  <button type="button" onClick={() => setOpen(isOpen ? null : p.id)} className="flex w-full cursor-pointer items-center gap-3 p-4 text-left" data-fx="own">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}>
                      <Pill size={19} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-slate-900">
                        {p.items?.[0]?.name ?? 'Prescription'}
                        {p.items?.length > 1 ? ` +${p.items.length - 1} more` : ''}
                      </span>
                      <span className="block truncate text-xs text-slate-500">
                        {fmt(p.created_at)} · {a.doctors?.name ?? 'Doctor'}
                        {a.clinics?.name ? ` · ${a.clinics.name}` : ''}
                      </span>
                    </span>
                    <motion.span animate={{ rotate: isOpen ? 180 : 0 }} className="text-slate-400"><ChevronDown size={18} /></motion.span>
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                        <div className="border-t border-slate-100 bg-slate-50/60 p-4">
                          {diagnosis && <p className="mb-3 text-xs text-slate-600"><span className="font-semibold text-slate-800">Diagnosis:</span> {diagnosis}</p>}
                          <div className="space-y-2">
                            {(p.items ?? []).map((it, n) => (
                              <motion.div
                                key={n}
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: n * 0.06 }}
                                className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2.5 ring-1 ring-slate-100"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-semibold text-slate-900">{it.name}</span>
                                  <span className="block text-xs text-slate-500">{it.dosage} · {it.frequency}</span>
                                </span>
                                <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">{it.durationDays} day{it.durationDays === 1 ? '' : 's'}</span>
                              </motion.div>
                            ))}
                          </div>
                          {p.signed_by && <p className="mt-3 text-xs text-slate-500">Signed by {p.signed_by}</p>}
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => downloadPrescriptionText(p, { doctor: a.doctors?.name, clinic: a.clinics?.name, patient: members.find((m) => m.id === a.member_id)?.name })}
                              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white"
                            >
                              <Download size={14} /> Download
                            </button>
                            <button type="button" onClick={() => navigate(`/bookings/${a.id}`)} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                              <ExternalLink size={14} /> Open the visit
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        )}

        {/* uploaded files for every file-based category */}
        {key !== 'encounters' && files.length > 0 && (
          <>
            {key === 'prescriptions' && <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Uploaded prescription files</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              {files.map(({ f, a }, i) => (
                <motion.div
                  key={f.id}
                  initial={{ opacity: 0, y: 18, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ delay: Math.min(i, 8) * 0.06 }}
                  whileHover={{ y: -3 }}
                  className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}>
                      <meta.Icon size={20} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-slate-900">{f.storage_path.split('/').pop()?.replace(/^[0-9a-f-]{36}-/, '') ?? 'File'}</span>
                      <span className="block truncate text-xs text-slate-500">{fmt(f.created_at)} · {a.doctors?.name ?? 'Doctor'}{a.clinics?.name ? ` · ${a.clinics.name}` : ''}</span>
                    </span>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={() => void act(() => openAppointmentFile(f.id))} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white">
                      <ExternalLink size={14} /> View
                    </button>
                    <button type="button" onClick={() => void act(() => downloadAppointmentFile(f.id))} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                      <Download size={14} /> Download
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
