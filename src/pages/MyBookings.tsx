import { Bell, CalendarDays, ChevronRight, Clock, MapPin } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import AppHeader from '../components/ui/AppHeader';
import Card from '../components/ui/Card';
import Segmented from '../components/ui/Segmented';
import StatusPill from '../components/ui/StatusPill';
import { todayISO } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import type { AppointmentStatus } from '../lib/types';
import { useUnreadNotifications } from '../lib/useUnreadNotifications';

interface Row {
  id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  token_number: number | null;
  doctors: { name: string; specialty: string | null } | null;
  clinics: { name: string; address: string | null } | null;
  family_members: { name: string; mrn: string } | null;
}

type Tab = 'upcoming' | 'completed' | 'cancelled';

const TABS: { value: Tab; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const UPCOMING: AppointmentStatus[] = ['booked', 'accepted', 'checked_in', 'called', 'in_consultation'];
const COMPLETED: AppointmentStatus[] = ['completed'];
const CANCELLED: AppointmentStatus[] = ['cancelled', 'rejected', 'no_show'];

const STATUS_TONE: Record<AppointmentStatus, 'live' | 'warning' | 'info' | 'neutral'> = {
  booked: 'warning',
  accepted: 'info',
  checked_in: 'live',
  called: 'live',
  in_consultation: 'live',
  completed: 'info',
  rejected: 'neutral',
  cancelled: 'neutral',
  no_show: 'neutral',
};

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  booked: 'Awaiting clinic',
  accepted: 'Confirmed',
  checked_in: 'Checked in',
  called: "You're being called",
  in_consultation: 'With the doctor',
  completed: 'Completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

export default function MyBookings() {
  const navigate = useNavigate();
  const hasUnread = useUnreadNotifications();
  const [rows, setRows] = useState<Row[]>([]);
  const [tab, setTab] = useState<Tab>('upcoming');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('appointments')
      .select(
        'id, date, slot_time, status, token_number, doctors(name, specialty), clinics(name, address), family_members(name, mrn)'
      )
      .order('date', { ascending: false })
      .order('slot_time', { ascending: false })
      .then(({ data }) => {
        setRows((data ?? []) as unknown as Row[]);
        setLoading(false);
      });
  }, []);

  const visible = useMemo(() => {
    const bucket = tab === 'upcoming' ? UPCOMING : tab === 'completed' ? COMPLETED : CANCELLED;
    const filtered = rows.filter((r) => bucket.includes(r.status));
    // Upcoming reads soonest-first; history reads newest-first.
    return tab === 'upcoming' ? [...filtered].reverse() : filtered;
  }, [rows, tab]);

  const today = todayISO();

  return (
    <div>
      <AppHeader
        title="My Appointments"
        centered
        bellDot={hasUnread}
        onBellClick={() => navigate('/notifications')}
      />

      <div className="mx-auto max-w-md px-4 pb-6">
        <Segmented options={TABS} value={tab} onChange={setTab} variant="underline" />

        <div className="mt-4 space-y-3">
          {loading && <p className="text-sm text-slate-400">Loading...</p>}
          {!loading && visible.length === 0 && (
            <Card className="text-center">
              <p className="text-sm text-slate-500">
                {tab === 'upcoming' ? 'No upcoming appointments.' : `Nothing in ${tab}.`}
              </p>
              {tab === 'upcoming' && (
                <Link to="/search" className="mt-2 inline-block text-sm font-bold text-brand-600">
                  Book an appointment →
                </Link>
              )}
            </Card>
          )}

          {visible.map((r) => (
            <Link key={r.id} to={`/bookings/${r.id}`} className="block">
              <Card className="transition hover:border-brand-200">
                <div className="flex items-start justify-between gap-3">
                  <p className="flex items-center gap-1.5 text-sm font-bold text-brand-600">
                    <CalendarDays size={15} />
                    {new Date(r.date + 'T00:00:00').toLocaleDateString(undefined, {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })}
                    <span className="text-slate-300">•</span>
                    {formatTimeLabel(r.slot_time)}
                  </p>
                  <StatusPill label={STATUS_LABEL[r.status]} tone={STATUS_TONE[r.status]} />
                </div>

                <p className="mt-1.5 text-base font-bold text-slate-900">{r.doctors?.name ?? 'Doctor'}</p>
                <p className="text-sm text-slate-500">{r.doctors?.specialty ?? 'General Physician'}</p>

                {r.clinics && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-sm text-slate-500">
                    <MapPin size={14} className="mt-0.5 shrink-0 text-slate-400" />
                    <span className="min-w-0">
                      {r.clinics.name}
                      {r.clinics.address ? `, ${r.clinics.address}` : ''}
                    </span>
                  </p>
                )}

                <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <Clock size={13} className="text-slate-400" />
                    {r.date === today ? 'Today' : `For ${r.family_members?.name ?? 'you'}`}
                    {r.token_number != null && r.status !== 'completed' && (
                      <span className="ml-1 rounded-full bg-brand-50 px-2 py-0.5 font-bold text-brand-700">
                        Token #{r.token_number}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1">
                    {r.family_members?.mrn && <span className="font-mono">{r.family_members.mrn}</span>}
                    <ChevronRight size={15} className="text-slate-300" />
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>

        {tab === 'upcoming' && visible.length > 0 && (
          <div className="mt-4 flex items-center gap-3 rounded-2xl bg-brand-50 p-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white text-brand-600">
              <Bell size={18} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-brand-700">Need to reschedule or cancel?</p>
              <p className="text-xs leading-relaxed text-slate-600">
                Open an appointment to reschedule or cancel it, up to 2 hours before the appointment time.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
