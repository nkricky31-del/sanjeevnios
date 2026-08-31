import { useEffect, useState } from 'react';

import ClinicLocationPicker from '../components/ClinicLocationPicker';
import ClinicLocationPreview from '../components/ClinicLocationPreview';
import FullDayCancelForm from '../components/FullDayCancelForm';
import RejectAppointmentForm from '../components/RejectAppointmentForm';
import RxPendingWorklist from '../components/RxPendingWorklist';
import VisitScreen from '../components/VisitScreen';
import WalkInForm from '../components/WalkInForm';
import AppHeader from '../components/ui/AppHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import StatusPill from '../components/ui/StatusPill';
import { useAuth } from '../lib/AuthContext';
import { ageFromDob, todayISO } from '../lib/date';
import { computeNowServing } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import { TIERS, usageStatus } from '../lib/subscription';
import type { AppointmentStatus, Clinic, ClinicStatus, Subscription } from '../lib/types';
import ClinicDoctors from './ClinicDoctors';
import ClinicSignup from './ClinicSignup';

interface DoctorRow {
  id: string;
  name: string;
  consultation_fee: number;
}

interface QueueAppointment {
  id: string;
  status: AppointmentStatus;
  token_no: number | null;
  date: string;
  slot_time: string;
  payment_status: string;
  reminder_count: number;
  family_members: {
    name: string;
    relation: string | null;
    account_id: string;
    phone: string | null;
    gender: string | null;
    dob: string | null;
  } | null;
}

// account_id is needed to address a notification at the booking patient
// (not the clinic itself) - selecting it here relies on the same
// family_select RLS branch that already lets a clinic see a member's basic
// info once that member has booked at their clinic. phone/gender/dob are
// mostly populated for walk-ins (see WalkInForm.tsx) - shown as a quick
// context line so the desk isn't just working off a bare name.
const APPOINTMENT_COLUMNS =
  'id, status, token_no, date, slot_time, payment_status, reminder_count, family_members(name, relation, account_id, phone, gender, dob)';

function patientContextLine(m: QueueAppointment['family_members']): string | null {
  if (!m) return null;
  const parts: string[] = [];
  if (m.dob) parts.push(`${ageFromDob(m.dob)}y`);
  if (m.gender) parts.push(m.gender);
  if (m.phone) parts.push(`+${m.phone}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const REMINDER_LIMIT = 5;
// A waiting patient is flagged "up soon" once they're within this many
// tokens of whoever's currently being served - just a visual nudge for the
// clinic to consider sending a reminder, not a hard rule.
const NEAR_TOKEN_THRESHOLD = 2;

const STATUS_TONE: Record<AppointmentStatus, 'live' | 'warning' | 'info' | 'neutral'> = {
  pending: 'warning',
  accepted: 'live',
  in_progress: 'live',
  rejected: 'neutral',
  cancelled: 'neutral',
  done: 'info',
  no_show: 'neutral',
};

const CLINIC_STATUS_TONE: Record<ClinicStatus, 'live' | 'warning' | 'neutral'> = {
  pending: 'warning',
  approved: 'live',
  rejected: 'neutral',
};

const CLINIC_STATUS_LABEL: Record<ClinicStatus, string> = {
  pending: 'Pending admin approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

interface OpenVisit {
  appointmentId: string;
  patientName: string;
}

export default function ClinicQueue() {
  const { session } = useAuth();
  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [doctors, setDoctors] = useState<DoctorRow[]>([]);
  const [doctorId, setDoctorId] = useState('');
  const [queueDate, setQueueDate] = useState(todayISO);
  const [pending, setPending] = useState<QueueAppointment[]>([]);
  const [queue, setQueue] = useState<QueueAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [openVisit, setOpenVisit] = useState<OpenVisit | null>(null);
  const [rejectOpenFor, setRejectOpenFor] = useState<string | null>(null);
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [fullDayCancelOpen, setFullDayCancelOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<'queue' | 'doctors' | 'rx' | 'location'>('queue');

  const loadClinicAndDoctors = async () => {
    if (!session) return;
    const { data: clinicData } = await supabase
      .from('clinics')
      .select('*')
      .eq('owner_id', session.user.id)
      .maybeSingle();
    setClinic(clinicData);
    if (!clinicData) {
      setLoading(false);
      return;
    }
    const { data: doctorData } = await supabase
      .from('doctors')
      .select('id, name, consultation_fee')
      .eq('clinic_id', clinicData.id);
    setDoctors(doctorData ?? []);
    setDoctorId((prev) => prev || doctorData?.[0]?.id || '');

    // No row yet just means this clinic hasn't had a booking attempt since
    // enforce_clinic_booking_limit() started tracking usage - treated as
    // "free plan, 0 used" for display purposes.
    const { data: subData } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('clinic_id', clinicData.id)
      .maybeSingle();
    setSubscription(subData);

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
    // would never show up for the clinic to act on. Sorted by date then
    // slot so the inbox reads as "today's slots, then tomorrow's, ...".
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

  // A visit isn't done until it has an attached e-prescription or the
  // doctor explicitly said none is needed (visits.no_prescription) - see
  // VisitScreen.tsx, which is where either of those actually gets set.
  const moveToDone = async (appointmentId: string) => {
    setActionError(null);
    const { data: visitRows } = await supabase
      .from('visits')
      .select('no_prescription, prescriptions(status)')
      .eq('appointment_id', appointmentId)
      .order('created_at', { ascending: false })
      .limit(1);
    const visit = (visitRows ?? [])[0] as { no_prescription: boolean; prescriptions: { status: string }[] } | undefined;
    const rxComplete = !!visit && (visit.no_prescription || visit.prescriptions.some((p) => p.status === 'attached'));

    if (!rxComplete) {
      setActionError(
        'This visit needs a prescription attached (or "No prescription needed" ticked) before it can be marked done - open the visit to add one.'
      );
      return;
    }
    await setStatus(appointmentId, 'done');
  };

  // Capturing the held online payment (or leaving COD as-is, due at the
  // desk) and assigning the next token number both already happen in the DB
  // trigger on the status update itself - this just adds the patient notice
  // on top, reading back what the trigger did.
  const acceptAppointment = async (a: QueueAppointment) => {
    setActionError(null);
    const { data: updated, error } = await supabase
      .from('appointments')
      .update({ status: 'accepted' })
      .eq('id', a.id)
      .select('token_no, payment_status')
      .single();
    if (error || !updated) {
      setActionError(error?.message ?? 'Could not accept this booking.');
      return;
    }

    if (a.family_members?.account_id) {
      const paymentNote =
        updated.payment_status === 'captured'
          ? 'Your online payment has been confirmed.'
          : 'Payment is due at the desk (cash/COD).';
      await supabase.from('notifications').insert({
        user_id: a.family_members.account_id,
        appointment_id: a.id,
        type: 'appointment_accepted',
        message: `Your appointment is confirmed! Your token number is #${updated.token_no}. ${paymentNote}`,
      });
    }

    loadAppointments();
  };

  const callNext = async () => {
    const next = queue.find((q) => q.status === 'accepted');
    if (!next) return;
    await setStatus(next.id, 'in_progress');
  };

  const sendReminder = async (a: QueueAppointment) => {
    setActionError(null);
    const newCount = a.reminder_count + 1;
    const { error: reminderError } = await supabase
      .from('appointments')
      .update({ reminder_count: newCount })
      .eq('id', a.id);
    if (reminderError) {
      setActionError(reminderError.message);
      return;
    }

    if (a.family_members?.account_id) {
      await supabase.from('notifications').insert({
        user_id: a.family_members.account_id,
        appointment_id: a.id,
        type: 'clinic_reminder',
        message: `Reminder from the clinic: your turn (token #${a.token_no}) is coming up soon. Please be ready.`,
      });
    }

    // After the 5th reminder with no apparent response, auto-skip the token
    // to the end of today's queue instead of leaving it blocking everyone
    // behind it. The clinic can still mark a no-show manually at any time.
    if (newCount >= REMINDER_LIMIT) {
      const { data: maxRow } = await supabase
        .from('appointments')
        .select('token_no')
        .eq('doctor_id', doctorId)
        .eq('date', queueDate)
        .not('status', 'in', '(pending,rejected,cancelled)')
        .order('token_no', { ascending: false })
        .limit(1)
        .maybeSingle();
      const newToken = (maxRow?.token_no ?? a.token_no ?? 0) + 1;
      await supabase.from('appointments').update({ token_no: newToken }).eq('id', a.id);

      if (a.family_members?.account_id) {
        await supabase.from('notifications').insert({
          user_id: a.family_members.account_id,
          appointment_id: a.id,
          type: 'queue_skip',
          message: `You've missed ${REMINDER_LIMIT} reminders and been moved to the end of today's queue. Your new token is #${newToken}.`,
        });
      }
    }

    loadAppointments();
  };

  const signOut = () => supabase.auth.signOut();

  if (loading) return <p className="p-6 text-slate-400">Loading...</p>;

  if (!clinic) {
    return (
      <div>
        <AppHeader title="Clinic" />
        <div className="mx-auto max-w-md px-4 py-8">
          <ClinicSignup onRegistered={loadClinicAndDoctors} />
          <Button variant="ghost" onClick={signOut} className="mt-4">
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  if (openVisit) {
    return (
      <VisitScreen
        appointmentId={openVisit.appointmentId}
        doctorId={doctorId}
        patientName={openVisit.patientName}
        onClose={() => {
          setOpenVisit(null);
          loadAppointments();
        }}
      />
    );
  }

  const inProgressEntry = queue.find((q) => q.status === 'in_progress');
  const nextWaiting = queue.find((q) => q.status === 'accepted');
  // Every row in `queue` already has a token assigned (the accept trigger
  // guarantees that), computeNowServing's type just doesn't know that.
  const currentServing = computeNowServing(
    queue.filter((q): q is QueueAppointment & { token_no: number } => q.token_no != null)
  );

  // Group the pending inbox by date so it reads as "today's slots, then
  // tomorrow's, ..." instead of one flat list.
  let lastRenderedDate = '';

  return (
    <div>
      <AppHeader
        title={clinic.name}
        subtitle="Clinic dashboard"
        pill={<StatusPill label={CLINIC_STATUS_LABEL[clinic.status]} tone={CLINIC_STATUS_TONE[clinic.status]} />}
      />

      <div className="mx-auto max-w-md px-4 py-6">
        {clinic.status !== 'approved' && (
          <div className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            <p>
              Your clinic is {clinic.status === 'pending' ? 'awaiting admin approval' : 'rejected'} — it won't
              appear in patient search or accept bookings yet. You can still add doctors and set their
              availability now.
            </p>
            {clinic.status === 'rejected' && clinic.reject_reason && (
              <p className="mt-1 font-medium">Reason: {clinic.reject_reason}</p>
            )}
          </div>
        )}

        {!clinic.is_active && (
          <div className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">
            Your clinic has been deactivated by an admin — it can't take new bookings until reactivated.
          </div>
        )}

        {(() => {
          const tier = subscription?.tier ?? 'free';
          const bookingsUsed = subscription?.bookings_used ?? 0;
          const limit = TIERS[tier].monthlyBookingLimit;
          const status = usageStatus(tier, bookingsUsed);
          if (status === 'ok') return null;
          return (
            <div
              className={`mb-4 rounded-xl p-3 text-sm ${
                status === 'over_limit' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'
              }`}
            >
              {status === 'over_limit'
                ? `You've reached your ${TIERS[tier].label} plan limit (${bookingsUsed}/${limit} bookings this period) — new bookings will be declined until you upgrade or the period rolls over.`
                : `You're nearing your ${TIERS[tier].label} plan limit: ${bookingsUsed}/${limit} bookings used this period.`}
            </div>
          );
        })()}

        <div className="flex flex-wrap gap-1.5 rounded-2xl bg-slate-100 p-1.5">
          <button
            onClick={() => setView('queue')}
            className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-bold transition ${
              view === 'queue' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            Queue
          </button>
          <button
            onClick={() => setView('rx')}
            className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-bold transition ${
              view === 'rx' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            Rx pending
          </button>
          <button
            onClick={() => setView('doctors')}
            className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-bold transition ${
              view === 'doctors' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            Doctors
          </button>
          <button
            onClick={() => setView('location')}
            className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-bold transition ${
              view === 'location' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            Location
          </button>
        </div>

        {view === 'doctors' && (
          <div className="mt-4">
            <ClinicDoctors clinicId={clinic.id} />
          </div>
        )}

        {view === 'location' && (
          <div className="mt-4">
            <h2 className="mb-2 text-lg font-bold text-slate-900">Clinic location</h2>
            <ClinicLocationPicker
              clinicId={clinic.id}
              initialLat={clinic.lat}
              initialLng={clinic.lng}
              initialAddress={clinic.formatted_address}
              onSaved={(lat, lng, formattedAddress) =>
                setClinic((prev) => (prev ? { ...prev, lat, lng, formatted_address: formattedAddress } : prev))
              }
            />
            {clinic.lat != null && clinic.lng != null && (
              <>
                <p className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-slate-400">
                  How patients will see it
                </p>
                <ClinicLocationPreview
                  lat={clinic.lat}
                  lng={clinic.lng}
                  formattedAddress={clinic.formatted_address}
                  clinicName={clinic.name}
                />
              </>
            )}
          </div>
        )}

        {view === 'rx' && doctorId && (
          <div className="mt-4">
            <RxPendingWorklist
              doctorId={doctorId}
              onOpen={(appointmentId, patientName) => setOpenVisit({ appointmentId, patientName })}
            />
          </div>
        )}

        {view === 'queue' && (
          <>
            {doctors.length === 0 && (
              <p className="mt-4 text-sm text-slate-500">
                Add a doctor first (under the "Doctors" tab) before you can manage a queue.
              </p>
            )}

            {doctors.length > 1 && (
              <select
                value={doctorId}
                onChange={(e) => setDoctorId(e.target.value)}
                className="mt-4 w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}

            {actionError && <p className="mt-3 text-sm text-red-600">{actionError}</p>}

            {doctors.length > 0 && (
              <>
                <div className="mt-6 flex items-center justify-between">
                  <h2 className="text-lg font-bold text-slate-900">Pending approval</h2>
                  <button onClick={loadAppointments} className="text-sm font-medium text-brand-600">
                    Refresh
                  </button>
                </div>
                <div className="mt-2 space-y-2">
                  {pending.length === 0 && <p className="text-sm text-slate-400">Nothing waiting.</p>}
                  {pending.map((a) => {
                    const showDateHeader = a.date !== lastRenderedDate;
                    lastRenderedDate = a.date;
                    return (
                      <div key={a.id}>
                        {showDateHeader && (
                          <p className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-slate-400 first:mt-0">
                            {a.date}
                          </p>
                        )}
                        <Card>
                          <p className="font-semibold text-slate-900">{a.family_members?.name}</p>
                          {patientContextLine(a.family_members) && (
                            <p className="text-xs text-slate-400">{patientContextLine(a.family_members)}</p>
                          )}
                          <p className="text-sm text-slate-500">
                            {a.slot_time?.slice(0, 5)} · {a.payment_status}
                          </p>
                          <div className="mt-2 flex gap-2">
                            <Button onClick={() => acceptAppointment(a)}>Accept</Button>
                            <Button
                              variant="danger"
                              onClick={() => setRejectOpenFor((prev) => (prev === a.id ? null : a.id))}
                            >
                              {rejectOpenFor === a.id ? 'Cancel' : 'Reject'}
                            </Button>
                          </div>
                          {rejectOpenFor === a.id && a.family_members && (
                            <RejectAppointmentForm
                              appointmentId={a.id}
                              doctorId={doctorId}
                              date={a.date}
                              patientAccountId={a.family_members.account_id}
                              onRejected={() => {
                                setRejectOpenFor(null);
                                loadAppointments();
                              }}
                              onCancel={() => setRejectOpenFor(null)}
                            />
                          )}
                        </Card>
                      </div>
                    );
                  })}
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

                <div className="mt-2 flex flex-wrap gap-2">
                  <Button onClick={callNext} disabled={!!inProgressEntry || !nextWaiting}>
                    {nextWaiting ? `Call next — #${nextWaiting.token_no}` : 'Call next'}
                  </Button>
                  {inProgressEntry && (
                    <Button
                      onClick={() => moveToDone(inProgressEntry.id)}
                      className="!bg-emerald-600 hover:!bg-emerald-700"
                    >
                      Move to done — #{inProgressEntry.token_no}
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => setWalkInOpen((s) => !s)}>
                    {walkInOpen ? 'Cancel walk-in' : '+ Walk-in'}
                  </Button>
                  <Button variant="danger" onClick={() => setFullDayCancelOpen((s) => !s)}>
                    {fullDayCancelOpen ? 'Cancel' : 'Cancel full day'}
                  </Button>
                </div>

                {walkInOpen && (
                  <WalkInForm
                    clinicId={clinic.id}
                    doctors={doctors}
                    defaultDoctorId={doctorId}
                    onAdded={loadAppointments}
                    onCancel={() => setWalkInOpen(false)}
                  />
                )}

                {fullDayCancelOpen && (
                  <FullDayCancelForm
                    doctorId={doctorId}
                    date={queueDate}
                    onDone={loadAppointments}
                    onClose={() => setFullDayCancelOpen(false)}
                  />
                )}

                <div className="mt-3 space-y-2">
                  {queue.length === 0 && <p className="text-sm text-slate-400">No confirmed bookings for this date.</p>}
                  {queue.map((a) => {
                    const isNear =
                      a.status === 'accepted' &&
                      a.token_no != null &&
                      currentServing != null &&
                      a.token_no - currentServing <= NEAR_TOKEN_THRESHOLD;
                    return (
                      <Card key={a.id}>
                        <div className="flex items-center justify-between">
                          <p className="font-semibold text-slate-900">
                            #{a.token_no} — {a.family_members?.name}
                          </p>
                          <StatusPill label={a.status} tone={STATUS_TONE[a.status]} />
                        </div>
                        {patientContextLine(a.family_members) && (
                          <p className="text-xs text-slate-400">{patientContextLine(a.family_members)}</p>
                        )}

                        {a.status === 'accepted' && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {isNear && <StatusPill label="Up soon" tone="warning" />}
                            <span className="text-xs text-slate-400">
                              Reminders sent: {a.reminder_count}/{REMINDER_LIMIT}
                            </span>
                            <button
                              onClick={() => sendReminder(a)}
                              disabled={a.reminder_count >= REMINDER_LIMIT}
                              className="text-xs font-semibold text-brand-600 disabled:text-slate-300"
                            >
                              Send reminder
                            </button>
                          </div>
                        )}

                        <div className="mt-2 flex flex-wrap gap-2">
                          {(a.status === 'accepted' || a.status === 'in_progress') && (
                            <Button variant="secondary" onClick={() => setStatus(a.id, 'no_show')}>
                              No-show
                            </Button>
                          )}
                          {(a.status === 'in_progress' || a.status === 'done') && (
                            <Button
                              variant="secondary"
                              onClick={() => setOpenVisit({ appointmentId: a.id, patientName: a.family_members?.name ?? 'Patient' })}
                            >
                              Open visit
                            </Button>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        <Button variant="ghost" onClick={signOut} className="mt-6">
          Sign out
        </Button>
      </div>
    </div>
  );
}
