import { CheckCircle2, ChevronRight, Monitor, ScanLine, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import ClinicBilling from '../components/ClinicBilling';
import ClinicBookingMode from '../components/ClinicBookingMode';
import ClinicCheckIn from '../components/ClinicCheckIn';
import ClinicHolidays from '../components/ClinicHolidays';
import ClinicLocationPicker from '../components/ClinicLocationPicker';
import ClinicLocationPreview from '../components/ClinicLocationPreview';
import FullDayCancelForm from '../components/FullDayCancelForm';
import PatientLookup from '../components/PatientLookup';
import PublishDaySchedule from '../components/PublishDaySchedule';
import RejectAppointmentForm from '../components/RejectAppointmentForm';
import RxPendingWorklist from '../components/RxPendingWorklist';
import VisitScreen from '../components/VisitScreen';
import WaitingList from '../components/WaitingList';
import WalkInForm from '../components/WalkInForm';
import AppHeader from '../components/ui/AppHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import IconTile from '../components/ui/IconTile';
import SectionTitle from '../components/ui/SectionTitle';
import Segmented from '../components/ui/Segmented';
import StatusPill from '../components/ui/StatusPill';
import { useAuth } from '../lib/AuthContext';
import { ageFromDob, todayISO } from '../lib/date';
import { appointmentConfirmedMessage, notifyPatient } from '../lib/notify';
import { bookingReference } from '../lib/queue';
import { captureRazorpayPayment } from '../lib/razorpay';
import { supabase } from '../lib/supabaseClient';
import { TIERS, usageStatus } from '../lib/subscription';
import { formatTimeLabel } from '../lib/time';
import { PAYMENT_STATUS_LABEL } from '../lib/types';
import type {
  AppointmentPaymentStatus,
  AppointmentStatus,
  CheckInResult,
  Clinic,
  ClinicStatus,
  PatientType,
  Subscription,
} from '../lib/types';
import { useUnreadNotifications } from '../lib/useUnreadNotifications';
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
  token_number: number | null;
  arrival_seq: number | null;
  checked_in_at: string | null;
  check_in_method: string | null;
  patient_type: PatientType;
  date: string;
  slot_time: string;
  payment_status: AppointmentPaymentStatus;
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
  'id, status, token_number, arrival_seq, checked_in_at, check_in_method, patient_type, date, slot_time, payment_status, reminder_count, family_members(name, relation, account_id, phone, gender, dob)';

// Everyone who has physically arrived and isn't finished - i.e. everyone
// holding a live token right now.
const LIVE_STATUSES: AppointmentStatus[] = ['checked_in', 'called', 'in_consultation'];
const FINISHED_STATUSES: AppointmentStatus[] = ['completed', 'no_show'];

function patientContextLine(m: QueueAppointment['family_members']): string | null {
  if (!m) return null;
  const parts: string[] = [];
  if (m.dob) parts.push(`${ageFromDob(m.dob)}y`);
  if (m.gender) parts.push(m.gender);
  if (m.phone) parts.push(`+${m.phone}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const REMINDER_LIMIT = 5;

const STATUS_TONE: Record<AppointmentStatus, 'live' | 'warning' | 'info' | 'neutral' | 'danger'> = {
  booked: 'warning',
  accepted: 'info',
  checked_in: 'live',
  called: 'live',
  in_consultation: 'live',
  completed: 'info',
  cancelled: 'neutral',
  rejected: 'neutral',
  no_show: 'danger',
};

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  booked: 'Booked',
  accepted: 'Accepted',
  checked_in: 'Waiting',
  called: 'Called',
  in_consultation: 'In consultation',
  completed: 'Completed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  no_show: 'No-show',
};

const CLINIC_STATUS_TONE: Record<ClinicStatus, 'live' | 'warning' | 'neutral'> = {
  draft: 'neutral',
  pending: 'warning',
  approved: 'live',
  rejected: 'neutral',
};

const CLINIC_STATUS_LABEL: Record<ClinicStatus, string> = {
  draft: 'Onboarding in progress',
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
  const navigate = useNavigate();
  const hasUnread = useUnreadNotifications();
  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [doctors, setDoctors] = useState<DoctorRow[]>([]);
  const [doctorId, setDoctorId] = useState('');
  const [queueDate, setQueueDate] = useState(todayISO);
  const [pending, setPending] = useState<QueueAppointment[]>([]);
  const [dayRows, setDayRows] = useState<QueueAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [openVisit, setOpenVisit] = useState<OpenVisit | null>(null);
  const [rejectOpenFor, setRejectOpenFor] = useState<string | null>(null);
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [fullDayCancelOpen, setFullDayCancelOpen] = useState(false);
  const [holidaysOpen, setHolidaysOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  // Bumped after a check-in so the waiting list reloads even when the
  // realtime broadcast is slow or the socket has dropped.
  const [queueVersion, setQueueVersion] = useState(0);
  const [view, setView] = useState<
    'today' | 'queue' | 'publish' | 'doctors' | 'rx' | 'location' | 'patients' | 'booking' | 'billing'
  >('today');

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
      setDayRows([]);
      return;
    }

    // Bookings awaiting approval can be for ANY future date (patients book
    // ahead) - this must NOT be limited to today, or bookings for tomorrow
    // onward would never show up for the clinic to act on.
    const pendingQuery = supabase
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .eq('doctor_id', doctorId)
      .eq('status', 'booked')
      .order('date', { ascending: true })
      .order('slot_time', { ascending: true });

    // Everything else for the selected day: who's expected, who's actually
    // here, and who's finished.
    const dayQuery = supabase
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .eq('doctor_id', doctorId)
      .eq('date', queueDate)
      .in('status', ['accepted', ...LIVE_STATUSES, ...FINISHED_STATUSES]);

    const [{ data: pendingData }, { data: dayData }] = await Promise.all([pendingQuery, dayQuery]);

    setPending((pendingData ?? []) as unknown as QueueAppointment[]);
    setDayRows((dayData ?? []) as unknown as QueueAppointment[]);
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
    setActionError(null);
    const { error } = await supabase.from('appointments').update({ status }).eq('id', id);
    if (error) {
      setActionError(error.message);
      return;
    }
    loadAppointments();
  };

  // Accepting only confirms the appointment - it does NOT hand out a number.
  // The token is drawn at the door, in arrival order (see
  // check_in_appointment() in schema.sql section 27), so the notice tells the
  // patient what to expect rather than quoting a number that doesn't exist yet.
  //
  // For an online Razorpay booking, the REAL capture (an actual API call
  // that moves money) happens first - see razorpay-capture-payment's own
  // header comment for why. Only once that succeeds (or reports nothing to
  // capture - COD, or no verified payment at all) does the status flip
  // happen, so the local database can never show "accepted" while Razorpay
  // disagrees about the money.
  //
  // The .eq('status', 'booked') guard makes this idempotent against a
  // double-tap or two clinic staff acting on the same row at once: only the
  // click that actually flips 'booked' -> 'accepted' gets a row back, so a
  // second click just refreshes the (by-then-stale) list below instead of
  // re-notifying the patient (and re-capturing nothing, since
  // razorpay-capture-payment itself is a no-op once payments.status is no
  // longer 'hold'). handle_appointment_status_change() (migrations 39/41)
  // flips the local payments row to captured and confirms any coupon
  // redemption as part of this same status update.
  const acceptAppointment = async (a: QueueAppointment) => {
    setActionError(null);

    const capture = await captureRazorpayPayment(a.id);
    if (!capture.captured) {
      setActionError(capture.error ?? 'Could not capture this payment - the appointment was not accepted.');
      return;
    }

    const { data: updated, error } = await supabase
      .from('appointments')
      .update({ status: 'accepted' })
      .eq('id', a.id)
      .eq('status', 'booked')
      .select('payment_status')
      .maybeSingle();
    if (error) {
      setActionError(error.message);
      return;
    }
    if (!updated) {
      loadAppointments();
      return;
    }

    if (a.family_members?.account_id) {
      const paidOnline = updated.payment_status === 'paid_online';
      await notifyPatient({
        userId: a.family_members.account_id,
        appointmentId: a.id,
        type: 'appointment_confirmed',
        message: appointmentConfirmedMessage(
          a.slot_time,
          bookingReference(a.id),
          paidOnline,
          clinic?.report_before_minutes ?? 30
        ),
      });
    }

    loadAppointments();
  };

  // THE check-in. Everything that matters - the guardrails, the arrival
  // counter, the token itself - happens server-side in one call; this only
  // reports what came back. A second press is harmless: the function returns
  // the token already held rather than issuing a new one.
  const checkIn = async (a: QueueAppointment) => {
    setActionError(null);
    setActionNote(null);
    const { data, error } = await supabase.rpc('check_in_appointment', {
      p_appointment_id: a.id,
      p_method: 'manual',
    });
    if (error) {
      setActionError(error.message);
      return;
    }
    const result = ((data ?? []) as CheckInResult[])[0];
    if (!result) {
      setActionError('Check-in did not return a token - please try again.');
      return;
    }

    setActionNote(
      result.already_checked_in
        ? `${a.family_members?.name ?? 'This patient'} is already checked in — token #${result.token_number}.`
        : `Checked in ${a.family_members?.name ?? 'patient'} — token #${result.token_number}.`
    );

    if (!result.already_checked_in && a.family_members?.account_id) {
      await supabase.from('notifications').insert({
        user_id: a.family_members.account_id,
        appointment_id: a.id,
        type: 'checked_in',
        message: `You're checked in. Your token number is #${result.token_number}. Please wait to be called.`,
      });
    }

    loadAppointments();
  };

  // Call next / start / complete all live in WaitingList (Today tab), which
  // owns the live queue and its own reload, so they aren't duplicated here.

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
      const holdsToken = a.token_number != null;
      await supabase.from('notifications').insert({
        user_id: a.family_members.account_id,
        appointment_id: a.id,
        type: 'clinic_reminder',
        message: holdsToken
          ? `Reminder from the clinic: token #${a.token_number} is coming up soon. Please be ready.`
          : `Reminder from the clinic: your ${formatTimeLabel(a.slot_time)} appointment is coming up. Please come to the desk to check in and collect your token.`,
      });
    }

    loadAppointments();
  };

  const signOut = () => supabase.auth.signOut();

  if (loading) return <p className="p-6 text-slate-400">Loading...</p>;

  if (!clinic) {
    return (
      <div>
        <AppHeader title="Clinic" bellDot={hasUnread} onBellClick={() => navigate('/notifications')} />
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

  // Expected = confirmed but not yet through the door. Live = holding a
  // token. Finished = seen or written off for the day.
  const expected = dayRows
    .filter((r) => r.status === 'accepted')
    .sort((a, b) => a.slot_time.localeCompare(b.slot_time));
  const live = dayRows
    .filter((r) => LIVE_STATUSES.includes(r.status))
    .sort((a, b) => (a.token_number ?? 0) - (b.token_number ?? 0));
  const finished = dayRows
    .filter((r) => FINISHED_STATUSES.includes(r.status))
    .sort((a, b) => (a.token_number ?? 0) - (b.token_number ?? 0));

  const isToday = queueDate === todayISO();

  // Group the approval inbox by date so it reads as "today's slots, then
  // tomorrow's, ..." instead of one flat list.
  let lastRenderedDate = '';

  const renderPatientRow = (a: QueueAppointment) => (
    <div className="flex items-start gap-3">
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-base font-extrabold ${
          a.token_number == null
            ? 'bg-slate-100 text-slate-400'
            : a.status === 'called' || a.status === 'in_consultation'
              ? 'bg-brand-600 text-white'
              : a.status === 'completed' || a.status === 'no_show'
                ? 'bg-slate-100 text-slate-400'
                : 'bg-brand-50 text-brand-700'
        }`}
      >
        {a.token_number ?? '—'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate font-bold text-slate-900">{a.family_members?.name}</p>
          <StatusPill label={STATUS_LABEL[a.status]} tone={STATUS_TONE[a.status]} />
        </div>
        {patientContextLine(a.family_members) && (
          <p className="truncate text-xs text-slate-400">{patientContextLine(a.family_members)}</p>
        )}
        <p className="text-xs text-slate-400">
          <span className="font-mono">Ref {bookingReference(a.id)}</span> · slot {formatTimeLabel(a.slot_time)}
          {a.checked_in_at && (
            <> · in at {new Date(a.checked_in_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</>
          )}
        </p>
      </div>
    </div>
  );

  return (
    <div>
      <AppHeader
        title={clinic.name}
        subtitle="Clinic dashboard"
        pill={<StatusPill label={CLINIC_STATUS_LABEL[clinic.status]} tone={CLINIC_STATUS_TONE[clinic.status]} />}
        bellDot={hasUnread}
        onBellClick={() => navigate('/notifications')}
      />

      <div className="mx-auto max-w-md px-4 pb-6">
        {clinic.status !== 'approved' && (
          <div className="mb-4 rounded-2xl bg-amber-50 p-3.5 text-sm text-amber-800">
            <p>
              Your clinic is{' '}
              {clinic.status === 'draft'
                ? 'still being set up - finish and submit your documents under the Doctors tab'
                : clinic.status === 'pending'
                  ? 'awaiting admin approval'
                  : 'rejected'}{' '}
              — it won't appear in patient search or accept bookings yet. You can still add doctors and set their
              availability now.
            </p>
            {clinic.status === 'rejected' && clinic.reject_reason && (
              <p className="mt-1 font-medium">Reason: {clinic.reject_reason}</p>
            )}
          </div>
        )}

        {!clinic.is_active && (
          <div className="mb-4 rounded-2xl bg-red-50 p-3.5 text-sm text-red-800">
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
              className={`mb-4 rounded-2xl p-3.5 text-sm ${
                status === 'over_limit' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'
              }`}
            >
              {status === 'over_limit'
                ? `You've reached your ${TIERS[tier].label} plan limit (${bookingsUsed}/${limit} bookings this period) — new bookings will be declined until you upgrade or the period rolls over.`
                : `You're nearing your ${TIERS[tier].label} plan limit: ${bookingsUsed}/${limit} bookings used this period.`}
            </div>
          );
        })()}

        <Segmented
          options={[
            { value: 'today', label: 'Today' },
            { value: 'queue', label: 'Bookings' },
            { value: 'publish', label: 'Publish day' },
            { value: 'rx', label: 'Rx pending' },
            { value: 'doctors', label: 'Doctors' },
            { value: 'booking', label: 'Booking mode' },
            { value: 'billing', label: 'Billing' },
            { value: 'location', label: 'Location' },
            { value: 'patients', label: 'Patients' },
          ]}
          value={view}
          onChange={setView}
          variant="scroll"
        />

        {/* The arrivals desk: scan or mark arrived, then work the waiting list. */}
        {view === 'today' && (
          <>
            {doctors.length === 0 && (
              <p className="mt-4 text-sm text-slate-500">
                Add a doctor first (under the "Doctors" tab) before you can check anyone in.
              </p>
            )}

            {doctors.length > 0 && (
              <>
                <div className="mt-4 flex items-center justify-between gap-2">
                  {doctors.length > 1 ? (
                    <select
                      value={doctorId}
                      onChange={(e) => setDoctorId(e.target.value)}
                      className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold outline-none focus:ring-2 focus:ring-brand-500"
                    >
                      {doctors.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="truncate text-sm font-bold text-slate-900">{doctors[0]?.name}</span>
                  )}
                  <input
                    type="date"
                    value={queueDate}
                    onChange={(e) => setQueueDate(e.target.value)}
                    className="shrink-0 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {/* WalkInForm always books TODAY (schema.sql section 27), and an
                      appointment_only clinic only accepts a same-day walk-in once
                      it has opted into same-day booking (section 37) - otherwise
                      enforce_booking_policy would just refuse the insert. */}
                  {(clinic.mode !== 'appointment_only' || clinic.same_day_booking_enabled) && (
                    <Button variant="secondary" onClick={() => setWalkInOpen((s) => !s)}>
                      {walkInOpen ? 'Cancel walk-in' : '+ Walk-in'}
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => navigate('/board')}>
                    <Monitor size={16} /> Token board
                  </Button>
                  {clinic.self_checkin_enabled && (
                    <Button variant="outline" onClick={() => navigate('/poster')}>
                      <ScanLine size={16} /> Self check-in code
                    </Button>
                  )}
                </div>

                {walkInOpen && (
                  <WalkInForm
                    clinicId={clinic.id}
                    doctors={doctors}
                    defaultDoctorId={doctorId}
                    onAdded={() => {
                      loadAppointments();
                      setQueueVersion((v) => v + 1);
                    }}
                    onCancel={() => setWalkInOpen(false)}
                  />
                )}

                <ClinicCheckIn
                  doctorId={doctorId}
                  date={queueDate}
                  clinicId={clinic.id}
                  onCheckedIn={() => {
                    loadAppointments();
                    setQueueVersion((v) => v + 1);
                  }}
                />

                <div className="mt-8">
                  <WaitingList
                    doctorId={doctorId}
                    date={queueDate}
                    refreshKey={queueVersion}
                    reminderLimit={clinic.reminder_limit ?? 3}
                    onChanged={loadAppointments}
                    onOpenVisit={(appointmentId, patientName) => setOpenVisit({ appointmentId, patientName })}
                  />
                </div>
              </>
            )}
          </>
        )}

        {view === 'booking' && (
          <div className="mt-4">
            <ClinicBookingMode
              clinic={clinic}
              onSaved={(patch) => setClinic((prev) => (prev ? { ...prev, ...patch } : prev))}
            />
          </div>
        )}

        {view === 'billing' && (
          <div className="mt-4">
            <ClinicBilling clinicId={clinic.id} />
          </div>
        )}

        {view === 'publish' && (
          <div className="mt-4">
            <PublishDaySchedule
              clinic={clinic}
              onClinicSaved={(patch) => setClinic((prev) => (prev ? { ...prev, ...patch } : prev))}
            />
          </div>
        )}

        {view === 'patients' && (
          <div className="mt-4">
            <PatientLookup />
          </div>
        )}

        {view === 'doctors' && (
          <div className="mt-4">
            <ClinicDoctors
              clinic={clinic}
              onClinicSaved={(patch) => setClinic((prev) => (prev ? { ...prev, ...patch } : prev))}
            />
          </div>
        )}

        {view === 'location' && (
          <div className="mt-4">
            <h2 className="mb-2 text-base font-bold text-slate-900">Clinic location</h2>
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
                className="mt-4 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold outline-none focus:ring-2 focus:ring-brand-500"
              >
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}

            {actionError && <p className="mt-3 text-sm text-red-600">{actionError}</p>}
            {actionNote && !actionError && (
              <p className="mt-3 rounded-2xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">{actionNote}</p>
            )}

            {doctors.length > 0 && (
              <>
                {/* 1. Bookings waiting for the clinic to confirm */}
                <SectionTitle className="mt-6" actionLabel="Refresh" onAction={loadAppointments}>
                  Pending approval
                </SectionTitle>
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
                          <div className="flex items-center gap-3">
                            <IconTile icon={UserRound} tone="amber" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-bold text-slate-900">{a.family_members?.name}</p>
                              {patientContextLine(a.family_members) && (
                                <p className="truncate text-xs text-slate-400">
                                  {patientContextLine(a.family_members)}
                                </p>
                              )}
                              <p className="text-sm font-medium text-brand-600">
                                {formatTimeLabel(a.slot_time)}
                                <span className="text-slate-400"> · {PAYMENT_STATUS_LABEL[a.payment_status]}</span>
                              </p>
                            </div>
                          </div>
                          <div className="mt-3 flex gap-2">
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
                              paymentStatus={a.payment_status}
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
                  <h2 className="text-base font-bold text-slate-900">The day's list</h2>
                  <input
                    type="date"
                    value={queueDate}
                    onChange={(e) => setQueueDate(e.target.value)}
                    className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-semibold outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
                <p className="mt-0.5 text-xs text-slate-400">
                  Arrivals and the live token queue live on the <strong>Today</strong> tab.
                </p>

                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="danger" onClick={() => setFullDayCancelOpen((s) => !s)}>
                    {fullDayCancelOpen ? 'Cancel' : 'Cancel full day'}
                  </Button>
                  <Button variant="secondary" onClick={() => setHolidaysOpen((s) => !s)}>
                    {holidaysOpen ? 'Hide holidays' : 'Holidays'}
                  </Button>
                </div>

                {fullDayCancelOpen && (
                  <FullDayCancelForm
                    doctorId={doctorId}
                    date={queueDate}
                    onDone={loadAppointments}
                    onClose={() => setFullDayCancelOpen(false)}
                  />
                )}

                {holidaysOpen && <ClinicHolidays clinicId={clinic.id} />}

                {/* 2. Expected today - confirmed, not yet arrived. No token. */}
                <SectionTitle className="mt-6">Expected ({expected.length})</SectionTitle>
                <p className="mt-0.5 text-xs text-slate-400">
                  Confirmed for this day but not yet arrived. Checking someone in issues their token, in arrival
                  order.
                </p>
                <div className="mt-2 space-y-2">
                  {expected.length === 0 && (
                    <p className="text-sm text-slate-400">Nobody left to check in for this date.</p>
                  )}
                  {expected.map((a) => (
                    <Card key={a.id}>
                      {renderPatientRow(a)}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button onClick={() => checkIn(a)} disabled={!isToday}>
                          <CheckCircle2 size={16} /> Check in
                        </Button>
                        <Button variant="secondary" onClick={() => setStatus(a.id, 'no_show')}>
                          No-show
                        </Button>
                        <span className="text-xs text-slate-400">
                          Reminders: {a.reminder_count}/{REMINDER_LIMIT}
                        </span>
                        <button
                          onClick={() => sendReminder(a)}
                          disabled={a.reminder_count >= REMINDER_LIMIT}
                          className="text-xs font-semibold text-brand-600 disabled:text-slate-300"
                        >
                          Send reminder
                        </button>
                      </div>
                      {!isToday && (
                        <p className="mt-1.5 text-xs text-slate-400">
                          Check-in is only possible on the day of the appointment.
                        </p>
                      )}
                    </Card>
                  ))}
                </div>

                {/* The live token queue lives on the Today tab (WaitingList),
                    so it isn't repeated here - two copies of the same list
                    with the same actions is a good way to have a receptionist
                    act on stale data. */}
                {live.length > 0 && (
                  <button
                    onClick={() => setView('today')}
                    className="mt-6 flex w-full items-center justify-between rounded-2xl bg-brand-50 p-4 text-left"
                  >
                    <span>
                      <span className="block text-sm font-bold text-brand-700">
                        {live.length} patient{live.length === 1 ? '' : 's'} in the live queue
                      </span>
                      <span className="block text-xs text-slate-600">
                        Open the Today tab to call, start and complete visits.
                      </span>
                    </span>
                    <ChevronRight size={18} className="shrink-0 text-brand-400" />
                  </button>
                )}

                {/* Done for the day */}
                {finished.length > 0 && (
                  <>
                    <SectionTitle className="mt-6">Finished ({finished.length})</SectionTitle>
                    <div className="mt-2 space-y-2">
                      {finished.map((a) => (
                        <Card key={a.id}>
                          {renderPatientRow(a)}
                          {a.status === 'completed' && (
                            <div className="mt-3">
                              <Button
                                variant="secondary"
                                onClick={() =>
                                  setOpenVisit({
                                    appointmentId: a.id,
                                    patientName: a.family_members?.name ?? 'Patient',
                                  })
                                }
                              >
                                Open visit
                              </Button>
                            </div>
                          )}
                        </Card>
                      ))}
                    </div>
                  </>
                )}
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
