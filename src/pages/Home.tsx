import {
  CalendarDays,
  CalendarPlus,
  ChevronRight,
  FileText,
  FlaskConical,
  HeartPulse,
  MoreHorizontal,
  Pill,
  ShieldCheck,
  UserRound,
  Wallet,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import AppHeader from '../components/ui/AppHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import IconTile, { type IconTone } from '../components/ui/IconTile';
import SectionTitle from '../components/ui/SectionTitle';
import StatusPill from '../components/ui/StatusPill';
import { todayISO } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import type { AppointmentStatus, FamilyMember } from '../lib/types';
import { useAuth } from '../lib/AuthContext';
import { useUnreadNotifications } from '../lib/useUnreadNotifications';

interface NextAppointment {
  id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  doctors: { name: string; specialty: string | null } | null;
  clinics: { name: string; address: string | null } | null;
}

interface RecentEncounter {
  id: string;
  visit_datetime: string;
  department: string | null;
  doctors: { name: string; specialty: string | null } | null;
}

const QUICK_ACTIONS: { label: string; icon: typeof CalendarDays; tone: IconTone; to: string }[] = [
  { label: 'My Appointments', icon: CalendarDays, tone: 'brand', to: '/bookings' },
  { label: 'Book Appointment', icon: CalendarPlus, tone: 'emerald', to: '/search' },
  { label: 'My Health Records', icon: FileText, tone: 'brand', to: '/records' },
  { label: 'Prescriptions', icon: Pill, tone: 'pink', to: '/records?category=prescriptions' },
  { label: 'Lab Reports', icon: FlaskConical, tone: 'emerald', to: '/records?category=lab_report' },
  { label: 'Bills & Payments', icon: Wallet, tone: 'sky', to: '/payments' },
  { label: 'Health Summary', icon: HeartPulse, tone: 'amber', to: '/records?category=encounters' },
  { label: 'My Profile', icon: UserRound, tone: 'brand', to: '/profile' },
];

const STATUS_TONE: Partial<Record<AppointmentStatus, 'live' | 'warning' | 'info' | 'neutral'>> = {
  accepted: 'live',
  pending: 'warning',
  in_progress: 'live',
};

const STATUS_LABEL: Partial<Record<AppointmentStatus, string>> = {
  accepted: 'Confirmed',
  pending: 'Awaiting clinic',
  in_progress: 'In progress',
};

const AVATAR_TONES: IconTone[] = ['brand', 'emerald', 'amber', 'pink'];

export default function Home() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const hasUnread = useUnreadNotifications();
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [next, setNext] = useState<NextAppointment | null>(null);
  const [encounters, setEncounters] = useState<RecentEncounter[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: memberData } = await supabase
        .from('family_members')
        .select('*')
        .order('created_at', { ascending: true });
      const memberRows = (memberData ?? []) as FamilyMember[];
      setMembers(memberRows);

      // Soonest booking that hasn't happened yet - the "Next Appointment"
      // hero card. Anything already done/cancelled is history, not "next".
      const { data: apptData } = await supabase
        .from('appointments')
        .select('id, date, slot_time, status, doctors(name, specialty), clinics(name, address)')
        .gte('date', todayISO())
        .in('status', ['pending', 'accepted', 'in_progress'])
        .order('date', { ascending: true })
        .order('slot_time', { ascending: true })
        .limit(1);
      setNext(((apptData ?? []) as unknown as NextAppointment[])[0] ?? null);

      const mrns = memberRows.map((m) => m.mrn).filter(Boolean);
      if (mrns.length > 0) {
        const { data: encounterData } = await supabase
          .from('encounters')
          .select('id, visit_datetime, department, doctors(name, specialty)')
          .in('mrn', mrns)
          .order('visit_datetime', { ascending: false })
          .limit(3);
        setEncounters((encounterData ?? []) as unknown as RecentEncounter[]);
      }

      setLoading(false);
    })();
  }, []);

  const self = members.find((m) => m.relation === 'self') ?? members[0];
  const firstName = (profile?.name ?? self?.name ?? '').split(' ')[0];

  return (
    <div>
      <AppHeader
        title={firstName ? `Hello, ${firstName} 👋` : 'Hello 👋'}
        subtitle={self?.mrn ? `MRN: ${self.mrn}` : undefined}
        bellDot={hasUnread}
        onBellClick={() => navigate('/notifications')}
      />

      <div className="mx-auto max-w-md px-4 pb-6">
        {/* Next appointment */}
        <Card className="!p-0">
          <div className="flex items-center justify-between gap-2 rounded-t-3xl bg-brand-50/70 px-4 py-3">
            <div className="flex items-center gap-2">
              <IconTile icon={CalendarDays} size="sm" />
              <p className="text-sm font-bold text-brand-700">Next Appointment</p>
            </div>
            <Link to="/bookings" className="rounded-full p-1 text-slate-400 hover:bg-white" aria-label="All appointments">
              <MoreHorizontal size={18} />
            </Link>
          </div>

          {loading ? (
            <p className="px-4 py-6 text-sm text-slate-400">Loading...</p>
          ) : next ? (
            <div className="px-4 pb-4 pt-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-bold text-brand-600">
                  {new Date(next.date + 'T00:00:00').toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}{' '}
                  · {formatTimeLabel(next.slot_time)}
                </p>
                <StatusPill
                  label={STATUS_LABEL[next.status] ?? next.status}
                  tone={STATUS_TONE[next.status] ?? 'neutral'}
                />
              </div>
              <p className="mt-1.5 text-lg font-bold text-slate-900">{next.doctors?.name ?? 'Doctor'}</p>
              <p className="text-sm text-slate-500">{next.doctors?.specialty ?? 'General Physician'}</p>
              {next.clinics && (
                <p className="mt-1.5 text-sm text-slate-500">
                  📍 {next.clinics.name}
                  {next.clinics.address ? `, ${next.clinics.address}` : ''}
                </p>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => navigate('/search')}>
                  Reschedule
                </Button>
                <Button onClick={() => navigate(`/bookings/${next.id}`)}>View Details</Button>
              </div>
            </div>
          ) : (
            <div className="px-4 pb-4 pt-3">
              <p className="text-sm text-slate-500">No upcoming appointments.</p>
              <Button className="mt-3" full onClick={() => navigate('/search')}>
                Book an appointment
              </Button>
            </div>
          )}
        </Card>

        {/* Quick actions */}
        <SectionTitle className="mt-6">Quick Actions</SectionTitle>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {QUICK_ACTIONS.map((a) => (
            <Link
              key={a.label}
              to={a.to}
              className="flex flex-col items-center gap-2 rounded-2xl border border-slate-100 bg-white p-2.5 text-center transition hover:border-brand-200"
            >
              <IconTile icon={a.icon} tone={a.tone} size="sm" />
              <span className="text-[11px] font-semibold leading-tight text-slate-700">{a.label}</span>
            </Link>
          ))}
        </div>

        {/* Recent encounters */}
        <SectionTitle className="mt-6" actionLabel="View All" actionTo="/records">
          Recent Encounters
        </SectionTitle>
        <Card className="mt-2 !p-0">
          {loading && <p className="px-4 py-5 text-sm text-slate-400">Loading...</p>}
          {!loading && encounters.length === 0 && (
            <p className="px-4 py-5 text-sm text-slate-400">No visits recorded yet.</p>
          )}
          {encounters.map((e, i) => (
            <Link
              key={e.id}
              to={`/encounters/${e.id}`}
              className="flex items-center gap-3 border-b border-slate-50 px-4 py-3 last:border-b-0 hover:bg-slate-50"
            >
              <IconTile icon={UserRound} tone={AVATAR_TONES[i % AVATAR_TONES.length]} />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-400">
                  {new Date(e.visit_datetime).toLocaleDateString(undefined, {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  })}
                </p>
                <p className="truncate text-sm font-bold text-slate-900">{e.doctors?.name ?? 'Doctor'}</p>
                <p className="truncate text-xs text-slate-500">{e.doctors?.specialty ?? e.department ?? '—'}</p>
              </div>
              <span className="rounded-xl border border-brand-100 px-2.5 py-1.5 text-xs font-bold text-brand-600">
                View Record
              </span>
              <ChevronRight size={16} className="shrink-0 text-slate-300" />
            </Link>
          ))}
        </Card>

        {/* Footer banner */}
        <Link
          to="/profile"
          className="mt-4 flex items-center gap-3 rounded-2xl bg-brand-50 p-4 transition hover:bg-brand-100/70"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white text-brand-600">
            <ShieldCheck size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-brand-700">Your Health, Our Priority</span>
            <span className="block text-xs text-slate-600">Keep your records updated and stay healthy.</span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-brand-400" />
        </Link>
      </div>
    </div>
  );
}
