import { FileText, FlaskConical, HeartPulse, Lock, Pill, ScanLine, Search, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import AppHeader from '../components/ui/AppHeader';
import Card from '../components/ui/Card';
import IconTile, { type IconTone } from '../components/ui/IconTile';
import SectionTitle from '../components/ui/SectionTitle';
import { openAppointmentFile } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentFile, FamilyMember, Prescription, Visit } from '../lib/types';
import { useUnreadNotifications } from '../lib/useUnreadNotifications';

type CategoryKey = 'encounters' | 'prescriptions' | 'lab_report' | 'xray' | 'documents';

interface TimelineAppointment {
  id: string;
  date: string;
  slot_time: string;
  doctors: { name: string; specialty: string | null } | null;
  clinics: { name: string } | null;
  visits: (Visit & { prescriptions: Prescription[] })[];
  files: AppointmentFile[];
}

interface EncounterRow {
  id: string;
  encounter_no: string;
  visit_datetime: string;
  department: string | null;
  doctors: { name: string } | null;
  clinics: { name: string } | null;
}

// One flat, sortable shape so encounters, prescriptions and uploaded files
// can share the "Recent Records" list and every category view.
interface RecordItem {
  key: string;
  category: CategoryKey;
  title: string;
  meta: string;
  date: string;
  onOpen: () => void;
}

const CATEGORY_META: Record<CategoryKey, { label: string; blurb: string; icon: typeof FileText; tone: IconTone }> = {
  encounters: {
    label: 'Encounters & Visit Summary',
    blurb: 'Doctor visit notes and summaries',
    icon: FileText,
    tone: 'brand',
  },
  prescriptions: { label: 'Prescriptions', blurb: 'Medications prescribed by doctors', icon: Pill, tone: 'emerald' },
  lab_report: { label: 'Lab Reports', blurb: 'Blood tests, urine tests and more', icon: FlaskConical, tone: 'sky' },
  xray: { label: 'Imaging & Radiology', blurb: 'X-rays, MRI, CT scans and more', icon: ScanLine, tone: 'amber' },
  documents: { label: 'Medical Documents', blurb: 'Photos and other uploaded documents', icon: FileText, tone: 'pink' },
};

const CATEGORY_ORDER: CategoryKey[] = ['encounters', 'prescriptions', 'lab_report', 'xray', 'documents'];

export default function Records() {
  const navigate = useNavigate();
  const hasUnread = useUnreadNotifications();
  const [searchParams, setSearchParams] = useSearchParams();
  const [appointments, setAppointments] = useState<TimelineAppointment[]>([]);
  const [encounters, setEncounters] = useState<EncounterRow[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  const activeCategory = (searchParams.get('category') as CategoryKey | null) ?? null;

  useEffect(() => {
    (async () => {
      const { data: memberData } = await supabase.from('family_members').select('*');
      const members = (memberData ?? []) as FamilyMember[];
      const memberIds = members.map((m) => m.id);
      const mrns = members.map((m) => m.mrn).filter(Boolean);

      const [{ data: apptData }, { data: encounterData }] = await Promise.all([
        memberIds.length > 0
          ? supabase
              .from('appointments')
              .select(
                'id, date, slot_time, doctors(name, specialty), clinics(name), visits(id, appointment_id, notes, diagnosis, follow_up_date, no_prescription, created_at, prescriptions(id, visit_id, items, file_url, signed_by, status, created_at)), files(id, member_id, appointment_id, type, storage_path, created_at)'
              )
              .in('member_id', memberIds)
              .order('date', { ascending: false })
          : Promise.resolve({ data: [] }),
        mrns.length > 0
          ? supabase
              .from('encounters')
              .select('id, encounter_no, visit_datetime, department, doctors(name), clinics(name)')
              .in('mrn', mrns)
              .order('visit_datetime', { ascending: false })
          : Promise.resolve({ data: [] }),
      ]);

      setAppointments((apptData ?? []) as unknown as TimelineAppointment[]);
      setEncounters((encounterData ?? []) as unknown as EncounterRow[]);
      setLoading(false);
    })();
  }, []);

  const items = useMemo<RecordItem[]>(() => {
    const out: RecordItem[] = [];

    for (const e of encounters) {
      out.push({
        key: `enc-${e.id}`,
        category: 'encounters',
        title: `${e.doctors?.name ?? 'Visit'} — Visit Summary`,
        meta: `${e.encounter_no}${e.clinics?.name ? ` · ${e.clinics.name}` : ''}`,
        date: e.visit_datetime,
        onOpen: () => navigate(`/encounters/${e.id}`),
      });
    }

    for (const a of appointments) {
      for (const v of a.visits ?? []) {
        for (const p of v.prescriptions ?? []) {
          const firstDrug = p.items?.[0]?.name;
          out.push({
            key: `rx-${p.id}`,
            category: 'prescriptions',
            title: firstDrug
              ? `${firstDrug}${p.items.length > 1 ? ` +${p.items.length - 1} more` : ''}`
              : 'Prescription',
            meta: `${a.doctors?.name ?? 'Doctor'}${a.clinics?.name ? ` · ${a.clinics.name}` : ''}`,
            date: p.created_at,
            onOpen: () => navigate(`/bookings/${a.id}`),
          });
        }
      }
      for (const f of a.files ?? []) {
        const category: CategoryKey =
          f.type === 'lab_report' ? 'lab_report' : f.type === 'xray' ? 'xray' : 'documents';
        out.push({
          key: `file-${f.id}`,
          category,
          title:
            f.type === 'lab_report'
              ? 'Lab report'
              : f.type === 'xray'
                ? 'X-ray / imaging'
                : f.type === 'prescription'
                  ? 'Prescription document'
                  : 'Document',
          meta: `${a.doctors?.name ?? 'Doctor'}${a.clinics?.name ? ` · ${a.clinics.name}` : ''}`,
          date: f.created_at,
          onOpen: () => openAppointmentFile(f.storage_path),
        });
      }
    }

    return out.sort((x, y) => y.date.localeCompare(x.date));
  }, [appointments, encounters, navigate]);

  const counts = useMemo(() => {
    const c = {} as Record<CategoryKey, number>;
    for (const k of CATEGORY_ORDER) c[k] = 0;
    for (const i of items) c[i.category] += 1;
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        (!activeCategory || i.category === activeCategory) &&
        (!q || i.title.toLowerCase().includes(q) || i.meta.toLowerCase().includes(q))
    );
  }, [items, activeCategory, query]);

  const setCategory = (key: CategoryKey | null) => {
    if (key) setSearchParams({ category: key });
    else setSearchParams({});
  };

  return (
    <div>
      <AppHeader
        title="My Health Records"
        centered
        bellDot={hasUnread}
        onBellClick={() => navigate('/notifications')}
      />

      <div className="mx-auto max-w-md px-4 pb-6">
        <div className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-white px-3.5 py-3">
          <Search size={17} className="shrink-0 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your records"
            className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
        </div>

        <div className="mt-3 flex items-center gap-3 rounded-2xl bg-brand-50 p-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white text-brand-600">
            <ShieldCheck size={19} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-brand-700">All your health records in one place</p>
            <p className="text-xs text-slate-600">Secure, private and easy to access</p>
          </div>
        </div>

        <SectionTitle
          className="mt-6"
          actionLabel={activeCategory ? 'Clear filter' : undefined}
          onAction={() => setCategory(null)}
        >
          Record Categories
        </SectionTitle>
        <Card className="mt-2 !p-0">
          {CATEGORY_ORDER.map((key) => {
            const meta = CATEGORY_META[key];
            const active = activeCategory === key;
            return (
              <button
                key={key}
                onClick={() => setCategory(active ? null : key)}
                className={`flex w-full items-center gap-3 border-b border-slate-50 px-4 py-3.5 text-left transition last:border-b-0 ${
                  active ? 'bg-brand-50/60' : 'hover:bg-slate-50'
                }`}
              >
                <IconTile icon={meta.icon} tone={meta.tone} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-slate-900">{meta.label}</span>
                  <span className="block truncate text-xs text-slate-500">{meta.blurb}</span>
                </span>
                <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600">
                  {counts[key]}
                </span>
              </button>
            );
          })}
          <button
            onClick={() => navigate('/profile')}
            className="flex w-full items-center gap-3 border-t border-slate-50 px-4 py-3.5 text-left hover:bg-slate-50"
          >
            <IconTile icon={HeartPulse} tone="pink" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-slate-900">Health Info & Conditions</span>
              <span className="block text-xs text-slate-500">Known conditions, blood group and more</span>
            </span>
          </button>
        </Card>

        <SectionTitle className="mt-6">
          {activeCategory ? CATEGORY_META[activeCategory].label : 'Recent Records'}
        </SectionTitle>
        <Card className="mt-2 !p-0">
          {loading && <p className="px-4 py-5 text-sm text-slate-400">Loading...</p>}
          {!loading && visible.length === 0 && (
            <p className="px-4 py-5 text-sm text-slate-400">
              {query ? 'Nothing matches that search.' : 'No records here yet.'}
            </p>
          )}
          {visible.slice(0, activeCategory ? 100 : 6).map((i) => {
            const meta = CATEGORY_META[i.category];
            return (
              <button
                key={i.key}
                onClick={i.onOpen}
                className="flex w-full items-center gap-3 border-b border-slate-50 px-4 py-3.5 text-left last:border-b-0 hover:bg-slate-50"
              >
                <IconTile icon={meta.icon} tone={meta.tone} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-slate-900">{i.title}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {new Date(i.date).toLocaleDateString(undefined, {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })}{' '}
                    · {i.meta}
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand-700">
                  {meta.label.split(' ')[0]}
                </span>
              </button>
            );
          })}
        </Card>

        <div className="mt-4 flex items-center gap-3 rounded-2xl bg-slate-100/70 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white text-slate-500">
            <Lock size={18} />
          </span>
          <p className="text-xs leading-relaxed text-slate-600">
            Your data is encrypted and only visible to you, the clinics you visit, and Sanjeevni admins.
          </p>
        </div>
      </div>
    </div>
  );
}
