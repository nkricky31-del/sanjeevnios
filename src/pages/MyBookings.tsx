import { CalendarDays } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import AppHeader from '../components/ui/AppHeader';
import Card from '../components/ui/Card';
import StatusPill from '../components/ui/StatusPill';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentStatus } from '../lib/types';

interface Row {
  id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  token_no: number | null;
  doctors: { name: string } | null;
  clinics: { name: string } | null;
  family_members: { name: string } | null;
}

const STATUS_TONE: Record<AppointmentStatus, 'live' | 'warning' | 'info' | 'neutral'> = {
  pending: 'warning',
  accepted: 'live',
  in_progress: 'live',
  rejected: 'neutral',
  cancelled: 'neutral',
  done: 'info',
  no_show: 'neutral',
};

export default function MyBookings() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('appointments')
      .select('id, date, slot_time, status, token_no, doctors(name), clinics(name), family_members(name)')
      .in('status', ['pending', 'accepted', 'in_progress'])
      .order('date', { ascending: true })
      .order('slot_time', { ascending: true })
      .then(({ data }) => {
        setRows((data ?? []) as unknown as Row[]);
        setLoading(false);
      });
  }, []);

  return (
    <div>
      <AppHeader title="My bookings" />
      <div className="mx-auto max-w-md px-4 py-6">
        <div className="space-y-2.5">
          {loading && <p className="text-sm text-slate-400">Loading...</p>}
          {!loading && rows.length === 0 && <p className="text-sm text-slate-400">No upcoming bookings.</p>}
          {rows.map((r) => (
            <Link key={r.id} to={`/bookings/${r.id}`} className="block">
              <Card className="hover:shadow-md">
                <div className="flex items-center justify-between">
                  <p className="font-bold text-slate-900">{r.doctors?.name}</p>
                  <StatusPill label={r.status} tone={STATUS_TONE[r.status]} />
                </div>
                <p className="text-sm font-medium text-coral-600">{r.clinics?.name}</p>
                <div className="mt-2 flex items-center justify-between">
                  <p className="flex items-center gap-1.5 text-sm text-slate-500">
                    <CalendarDays size={14} className="text-slate-400" />
                    For {r.family_members?.name} · {r.date} at {r.slot_time?.slice(0, 5)}
                  </p>
                  {r.token_no && (
                    <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-bold text-brand-700">
                      #{r.token_no}
                    </span>
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
