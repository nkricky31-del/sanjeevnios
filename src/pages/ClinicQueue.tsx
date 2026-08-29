import { useEffect, useState } from 'react';

import VisitNotesForm from '../components/VisitNotesForm';
import AppHeader from '../components/ui/AppHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import StatusPill from '../components/ui/StatusPill';
import { useAuth } from '../lib/AuthContext';
import { todayISO } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentStatus } from '../lib/types';

interface ClinicRow {
  id: string;
  name: string;
}

interface DoctorRow {
  id: string;
  name: string;
}

interface QueueAppointment {
  id: string;
  status: AppointmentStatus;
  token_no: number | null;
  date: string;
  slot_time: string;
  payment_status: string;
  family_members: { name: string; relation: string } | null;
}

const APPOINTMENT_COLUMNS = 'id, status, token_no, date, slot_time, payment_status, family_members(name, relation)';

const STATUS_TONE: Record<AppointmentStatus, 'live' | 'warning' | 'info' | 'neutral'> = {
  pending: 'warning',
  accepted: 'live',
  in_progress: 'live',
  rejected: 'neutral',
  cancelled: 'neutral',
  done: 'info',
  no_show: 'neutral',
};

export default function ClinicQueue() {
  const { session } = useAuth();
  const [clinic, setClinic] = useState<ClinicRow | null>(null);
  const [doctors, setDoctors] = useState<DoctorRow[]>([]);
  const [doctorId, setDoctorId] = useState('');
  const [queueDate, setQueueDate] = useState(todayISO);
  const [pending, setPending] = useState<QueueAppointment[]>([]);
  const [queue, setQueue] = useState<QueueAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [notesOpenFor, setNotesOpenFor] = useState<string | null>(null);

  const loadClinicAndDoctors = async () => {
    if (!session) return;
    const { data: clinicData } = await supabase
      .from('clinics')
      .select('id, name')
      .eq('owner_id', session.user.id)
      .maybeSingle();
    setClinic(clinicData);
    if (!clinicData) {
      setLoading(false);
      return;
    }
    const { data: doctorData } = await supabase.from('doctors').select('id, name').eq('clinic_id', clinicData.id);
    setDoctors(doctorData ?? []);
    setDoctorId((prev) => prev || doctorData?.[0]?.id || '');
    setLoading(false);
  };

  const loadAppointments = async () => {
    if (!doctorId) {
      setPending([]);
      setQueue([]);
      return;
    }

    // Pending approvals can be for ANY future date (patients book ahead) -
    // this must NOT be limited to today, or bookings for tomorrow onward
    // would never show up for the clinic to act on.
    const pendingQuery = supabase
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .eq('doctor_id', doctorId)
      .eq('status', 'pending')
      .order('date', { ascending: true })
      .order('slot_time', { ascending: true });

    // The queue is scoped to whichever date is selected (defaults to today).
    const queueQuery = supabase
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .eq('doctor_id', doctorId)
      .eq('date', queueDate)
      .in('status', ['accepted', 'in_progress', 'done', 'no_show']);

    const [{ data: pendingData }, { data: queueData }] = await Promise.all([pendingQuery, queueQuery]);

    setPending((pendingData ?? []) as unknown as QueueAppointment[]);
    setQueue(
      ((queueData ?? []) as unknown as QueueAppointment[]).sort((a, b) => (a.token_no ?? 0) - (b.token_no ?? 0))
    );
  };

  useEffect(() => {
    loadClinicAndDoctors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    loadAppointments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId, queueDate]);

  const setStatus = async (id: string, status: AppointmentStatus) => {
    await supabase.from('appointments').update({ status }).eq('id', id);
    loadAppointments();
  };

  const signOut = () => supabase.auth.signOut();

  if (loading) return <p className="p-6 text-slate-400">Loading...</p>;

  if (!clinic) {
    return (
      <div>
        <AppHeader title="Clinic" />
        <div className="mx-auto max-w-md px-4 py-8">
          <p className="text-slate-500">
            No clinic is linked to this account yet. Clinic sign-up isn't built yet — for now, ask an admin to set
            this account up directly.
          </p>
          <Button variant="ghost" onClick={signOut} className="mt-4">
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <AppHeader title={clinic.name} subtitle="Clinic dashboard" pill={<StatusPill label="Live Queue" tone="live" />} />

      <div className="mx-auto max-w-md px-4 py-6">
        {doctors.length > 1 && (
          <select
            value={doctorId}
            onChange={(e) => setDoctorId(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}

        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">Pending approval</h2>
          <button onClick={loadAppointments} className="text-sm font-medium text-blue-600">
            Refresh
          </button>
        </div>
        <div className="mt-2 space-y-2">
          {pending.length === 0 && <p className="text-sm text-slate-400">Nothing waiting.</p>}
          {pending.map((a) => (
            <Card key={a.id}>
              <p className="font-semibold text-slate-900">{a.family_members?.name}</p>
              <p className="text-sm text-slate-500">
                {a.date} at {a.slot_time?.slice(0, 5)} · {a.payment_status}
              </p>
              <div className="mt-2 flex gap-2">
                <Button onClick={() => setStatus(a.id, 'accepted')}>Accept</Button>
                <Button variant="danger" onClick={() => setStatus(a.id, 'rejected')}>
                  Reject
                </Button>
              </div>
            </Card>
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-slate-900">Queue</h2>
          <input
            type="date"
            value={queueDate}
            onChange={(e) => setQueueDate(e.target.value)}
            className="rounded-xl border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <div className="mt-2 space-y-2">
          {queue.length === 0 && <p className="text-sm text-slate-400">No confirmed bookings for this date.</p>}
          {queue.map((a) => (
            <Card key={a.id}>
              <div className="flex items-center justify-between">
                <p className="font-semibold text-slate-900">
                  #{a.token_no} — {a.family_members?.name}
                </p>
                <StatusPill label={a.status} tone={STATUS_TONE[a.status]} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {a.status === 'accepted' && <Button onClick={() => setStatus(a.id, 'in_progress')}>Start</Button>}
                {a.status === 'in_progress' && (
                  <Button
                    onClick={() => setStatus(a.id, 'done')}
                    className="!bg-emerald-600 hover:!bg-emerald-700"
                  >
                    Done
                  </Button>
                )}
                {(a.status === 'accepted' || a.status === 'in_progress') && (
                  <Button variant="secondary" onClick={() => setStatus(a.id, 'no_show')}>
                    No-show
                  </Button>
                )}
                {(a.status === 'in_progress' || a.status === 'done') && (
                  <Button variant="secondary" onClick={() => setNotesOpenFor((prev) => (prev === a.id ? null : a.id))}>
                    {notesOpenFor === a.id ? 'Close' : 'Add visit notes'}
                  </Button>
                )}
              </div>
              {notesOpenFor === a.id && (
                <VisitNotesForm
                  appointmentId={a.id}
                  doctorId={doctorId}
                  onSaved={() => {
                    setNotesOpenFor(null);
                    loadAppointments();
                  }}
                  onCancel={() => setNotesOpenFor(null)}
                />
              )}
            </Card>
          ))}
        </div>

        <Button variant="ghost" onClick={signOut} className="mt-6">
          Sign out
        </Button>
      </div>
    </div>
  );
}
