import { BellRing, PlayCircle, SkipForward, UserRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { skipToBack } from '../lib/checkIn';
import { ageFromDob } from '../lib/date';
import { bookingReference } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import { PAYMENT_STATUS_LABEL, type AppointmentPaymentStatus, type AppointmentStatus } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import SectionTitle from './ui/SectionTitle';
import StatusPill from './ui/StatusPill';

interface Props {
  doctorId: string;
  date: string;
  onOpenVisit: (appointmentId: string, patientName: string) => void;
  /** Bump to force a reload from outside (e.g. after a check-in). */
  refreshKey?: number;
  onChanged?: () => void;
  /** How many unanswered reminders before "Skip to back" is offered. */
  reminderLimit?: number;
}

// One row of get_clinic_queue() - already ordered and positioned by the
// server, so this component never re-sorts anything.
interface QueueRow {
  queue_position: number;
  id: string;
  token_number: number | null;
  status: AppointmentStatus;
  slot_time: string;
  checked_in_at: string | null;
  effective_order_time: string | null;
  was_late: boolean;
  reminder_count: number;
  skip_count: number;
  payment_status: AppointmentPaymentStatus;
  patient_name: string | null;
  account_id: string | null;
  phone: string | null;
  gender: string | null;
  dob: string | null;
}

const STATUS_TONE: Record<string, 'live' | 'warning' | 'info' | 'neutral'> = {
  checked_in: 'warning',
  called: 'live',
  in_consultation: 'live',
};

const STATUS_LABEL: Record<string, string> = {
  checked_in: 'Waiting',
  called: 'Called',
  in_consultation: 'In consultation',
};

function contextLine(r: QueueRow): string | null {
  const parts: string[] = [];
  if (r.dob) parts.push(`${ageFromDob(r.dob)}y`);
  if (r.gender) parts.push(r.gender);
  if (r.phone) parts.push(`+${r.phone}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// The live queue for one doctor on one day.
//
// The ORDER is the server's, not this component's: get_clinic_queue() applies
// the fair-queue rule (effective_order_time, then checked_in_at) and hands
// back a position with every row. Sorting here would risk the desk seeing a
// different order from the patient app, which is exactly the argument at the
// reception counter this whole design exists to avoid.
export default function WaitingList({
  doctorId,
  date,
  onOpenVisit,
  refreshKey = 0,
  onChanged,
  reminderLimit = 3,
}: Props) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!doctorId) {
      setRows([]);
      setLoading(false);
      return;
    }
    const { data, error: loadError } = await supabase.rpc('get_clinic_queue', {
      p_doctor_id: doctorId,
      p_date: date,
    });
    if (loadError) setError(loadError.message);
    setRows((data ?? []) as QueueRow[]);
    setLoading(false);
  }, [doctorId, date]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Same broadcast channel the patient's own screen listens on, so the desk
  // sees a walk-in added on another till (or a doctor finishing) without
  // anyone pressing refresh.
  useEffect(() => {
    if (!doctorId) return;
    supabase.realtime.setAuth();
    const channel = supabase
      .channel(`queue:${doctorId}:${date}`)
      .on('broadcast', { event: 'UPDATE' }, () => load())
      .on('broadcast', { event: 'INSERT' }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [doctorId, date, load]);

  const setStatus = async (id: string, status: AppointmentStatus) => {
    setError(null);
    const { error: updateError } = await supabase.from('appointments').update({ status }).eq('id', id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    await load();
    onChanged?.();
  };

  const beingSeen = rows.find((r) => r.status === 'called' || r.status === 'in_consultation');
  const nextUp = rows.find((r) => r.status === 'checked_in');
  const nowServing = beingSeen?.token_number ?? null;

  // Calling is decided by the server too (call_next_patient), so the rule
  // lives in exactly one place. It refuses if someone is mid-consultation -
  // the doctor is never interrupted.
  const callNext = async () => {
    setError(null);
    setNote(null);
    const { data, error: callError } = await supabase.rpc('call_next_patient', {
      p_doctor_id: doctorId,
      p_date: date,
    });
    if (callError) {
      setError(callError.message);
      return;
    }
    const called = ((data ?? []) as { id: string; token_number: number; patient_name: string; account_id: string }[])[0];
    if (called) {
      setNote(`Now calling #${called.token_number} — ${called.patient_name}.`);
      if (called.account_id) {
        await supabase.from('notifications').insert({
          user_id: called.account_id,
          appointment_id: called.id,
          type: 'token_called',
          message: `Token #${called.token_number} is being called now — please go in.`,
        });
      }
    }
    await load();
    onChanged?.();
  };

  const sendReminder = async (r: QueueRow) => {
    setError(null);
    const newCount = r.reminder_count + 1;
    const { error: updateError } = await supabase
      .from('appointments')
      .update({ reminder_count: newCount })
      .eq('id', r.id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    if (r.account_id) {
      await supabase.from('notifications').insert({
        user_id: r.account_id,
        appointment_id: r.id,
        type: 'clinic_reminder',
        message: `Reminder from the clinic: token #${r.token_number} is being called. Please come to the consultation area.`,
      });
    }
    setNote(`Reminder ${newCount}/${reminderLimit} sent to ${r.patient_name ?? 'the patient'}.`);
    await load();
    onChanged?.();
  };

  // After the clinic's set number of unanswered reminders: a fresh token at
  // the back rather than writing them off. This also re-stamps their
  // effective_order_time, so they genuinely go to the end of the order.
  const skip = async (r: QueueRow) => {
    setError(null);
    const result = await skipToBack(r.id);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (r.account_id) {
      await supabase.from('notifications').insert({
        user_id: r.account_id,
        appointment_id: r.id,
        type: 'queue_skip',
        message: `You didn't come forward when token #${r.token_number} was called, so you've been moved to the back of today's queue. Your new token is #${result.token}.`,
      });
    }
    setNote(`${r.patient_name ?? 'Patient'} moved to the back — new token #${result.token}.`);
    await load();
    onChanged?.();
  };

  // A visit isn't complete until it has an attached e-prescription or the
  // doctor explicitly said none is needed (visits.no_prescription).
  const complete = async (appointmentId: string) => {
    setError(null);
    const { data: visitRows } = await supabase
      .from('visits')
      .select('no_prescription, prescriptions(status)')
      .eq('appointment_id', appointmentId)
      .order('created_at', { ascending: false })
      .limit(1);
    const visit = (visitRows ?? [])[0] as { no_prescription: boolean; prescriptions: { status: string }[] } | undefined;
    const rxComplete = !!visit && (visit.no_prescription || visit.prescriptions.some((p) => p.status === 'attached'));
    if (!rxComplete) {
      setError(
        'This visit needs a prescription attached (or "No prescription needed" ticked) before it can be completed - open the visit to add one.'
      );
      return;
    }
    await setStatus(appointmentId, 'completed');
  };

  return (
    <div>
      <SectionTitle actionLabel="Refresh" onAction={load}>
        Waiting ({rows.length})
      </SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">
        Ordered by appointment time for everyone who arrived on time, and by arrival time for anyone more than
        their grace period late. Payment is not part of the order.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button onClick={callNext} disabled={!!beingSeen || !nextUp}>
          {nextUp ? `Call next — #${nextUp.token_number}` : 'Call next'}
        </Button>
        {nowServing != null ? (
          <span className="text-xs font-semibold text-slate-500">Now serving: #{nowServing}</span>
        ) : (
          nextUp && <span className="text-xs font-semibold text-slate-500">Up next: #{nextUp.token_number}</span>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {note && !error && (
        <p className="mt-2 rounded-2xl bg-emerald-50 p-2.5 text-sm font-semibold text-emerald-700">{note}</p>
      )}

      <div className="mt-3 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && rows.length === 0 && <p className="text-sm text-slate-400">Nobody has checked in yet.</p>}

        {rows.map((r) => (
          <Card
            key={r.id}
            className={r.status === 'called' || r.status === 'in_consultation' ? '!border-brand-300' : ''}
          >
            <div className="flex items-start gap-3">
              {/* Position in line is what the order rule produces; the token
                  is the patient's fixed arrival number. Both are shown
                  because they answer different questions. */}
              <span className="flex shrink-0 flex-col items-center">
                <span
                  className={`flex h-12 w-12 items-center justify-center rounded-2xl text-lg font-extrabold ${
                    r.status === 'checked_in' ? 'bg-brand-50 text-brand-700' : 'bg-brand-600 text-white'
                  }`}
                >
                  {r.queue_position}
                </span>
                <span className="mt-1 text-[10px] font-semibold text-slate-400">#{r.token_number}</span>
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate font-bold text-slate-900">{r.patient_name ?? 'Patient'}</p>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {r.was_late && <StatusPill label="Late" tone="warning" />}
                    {r.skip_count > 0 && <StatusPill label={`Skipped ×${r.skip_count}`} tone="neutral" />}
                    <StatusPill label={STATUS_LABEL[r.status] ?? r.status} tone={STATUS_TONE[r.status] ?? 'neutral'} />
                  </div>
                </div>
                {contextLine(r) && <p className="truncate text-xs text-slate-400">{contextLine(r)}</p>}
                <p className="text-xs text-slate-400">
                  <span className="font-mono">Ref {bookingReference(r.id)}</span> · slot{' '}
                  {formatTimeLabel(r.slot_time)}
                  {r.checked_in_at && (
                    <>
                      {' '}
                      · in at{' '}
                      {new Date(r.checked_in_at).toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </>
                  )}
                  <span className="text-slate-300"> · {PAYMENT_STATUS_LABEL[r.payment_status]}</span>
                </p>
              </div>
            </div>

            {r.status === 'called' && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl bg-slate-50 px-3 py-2">
                <span className="text-xs text-slate-500">
                  Reminders: {r.reminder_count}/{reminderLimit}
                </span>
                <button
                  onClick={() => sendReminder(r)}
                  disabled={r.reminder_count >= reminderLimit}
                  className="inline-flex items-center gap-1 text-xs font-bold text-brand-600 disabled:text-slate-300"
                >
                  <BellRing size={13} /> Send reminder
                </button>
                {r.reminder_count >= reminderLimit && (
                  <button
                    onClick={() => skip(r)}
                    className="inline-flex items-center gap-1 text-xs font-bold text-amber-700"
                  >
                    <SkipForward size={13} /> Skip to back
                  </button>
                )}
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {r.status === 'called' && (
                <Button onClick={() => setStatus(r.id, 'in_consultation')}>
                  <PlayCircle size={16} /> Start consultation
                </Button>
              )}
              {r.status === 'in_consultation' && (
                <Button onClick={() => complete(r.id)} className="!bg-emerald-600 hover:!bg-emerald-700">
                  Complete
                </Button>
              )}
              {(r.status === 'called' || r.status === 'in_consultation') && (
                <Button variant="secondary" onClick={() => onOpenVisit(r.id, r.patient_name ?? 'Patient')}>
                  Open visit
                </Button>
              )}
              <Button variant="secondary" onClick={() => setStatus(r.id, 'no_show')}>
                <UserRound size={15} /> No-show
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
