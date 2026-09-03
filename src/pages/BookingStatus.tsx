import {
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  Clock,
  MapPin,
  QrCode as QrCodeIcon,
  RefreshCw,
  Stethoscope,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import ClinicLocationPreview from '../components/ClinicLocationPreview';
import FileUpload from '../components/FileUpload';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import IconTile from '../components/ui/IconTile';
import InfoNote from '../components/ui/InfoNote';
import ScreenHeader from '../components/ui/ScreenHeader';
import StatusPill from '../components/ui/StatusPill';
import VerifiedBadge from '../components/VerifiedBadge';
import VisitDetails from '../components/VisitDetails';
import { getCheckInOptions, type CheckInOptions } from '../lib/checkIn';
import { bookingReference, computeNowServing, countAhead } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import { estimateSlotMinutes, formatTimeLabel } from '../lib/time';
import type { AppointmentStatus, DoctorAvailability, Prescription, QueueStatusRow, Visit } from '../lib/types';

interface BookingDetail {
  id: string;
  member_id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  token_number: number | null;
  checked_in_at: string | null;
  // The published running order (schema.sql section 34) - a PLAN, assigned
  // the night before to every booked patient. Separate from token_number,
  // which only exists once this patient has actually checked in.
  sequence_no: number | null;
  estimated_time: string | null;
  reason: string | null;
  reject_reason: string | null;
  doctor_id: string;
  clinic_id: string;
  doctors: { name: string; specialty: string | null } | null;
  clinics: { name: string; address: string | null; lat: number | null; lng: number | null; formatted_address: string | null } | null;
  family_members: { name: string; mrn: string } | null;
  encounters: { encounter_no: string } | null;
}

// Statuses where something can still change - a rejected/cancelled/no_show
// booking is done, no point keeping a live channel open for it.
const WATCHED_STATUSES: AppointmentStatus[] = [
  'booked',
  'accepted',
  'checked_in',
  'called',
  'in_consultation',
  'completed',
];

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  booked: 'Pending clinic approval',
  accepted: 'Confirmed — check in when you arrive',
  checked_in: 'Checked in — waiting',
  called: "You're being called now",
  in_consultation: 'You are being seen now',
  completed: 'Completed',
  rejected: 'Rejected by clinic',
  cancelled: 'Cancelled',
  no_show: 'Marked as no-show',
};

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

// Fallback only - the real figure comes from the clinic, and is more
// forgiving for patients who paid online (see schema.sql section 32).
const DEFAULT_CANCEL_WINDOW_HOURS = 2;

export default function BookingStatus() {
  const { appointmentId } = useParams<{ appointmentId: string }>();
  const navigate = useNavigate();
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [queueRows, setQueueRows] = useState<QueueStatusRow[]>([]);
  const [slotMinutes, setSlotMinutes] = useState(15);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [visit, setVisit] = useState<(Visit & { prescriptions: Prescription[] }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [doctorVerified, setDoctorVerified] = useState(false);
  const [clinicVerified, setClinicVerified] = useState(false);
  const [options, setOptions] = useState<CheckInOptions | null>(null);
  const alerted = useRef({ thirty: false, next: false });

  const loadBooking = async () => {
    const { data } = await supabase
      .from('appointments')
      .select(
        '*, doctors(name, specialty), clinics(name, address, lat, lng, formatted_address), family_members(name, mrn), encounters(encounter_no)'
      )
      .eq('id', appointmentId)
      .single();
    setBooking(data as BookingDetail | null);
    setLoading(false);

    // Live-computed rather than read off a stored flag - see
    // is_currently_verified() in schema.sql.
    if (data) {
      const detail = data as BookingDetail;
      const [{ data: docVerified }, { data: clinicVerifiedData }] = await Promise.all([
        supabase.rpc('is_currently_verified', { p_owner_type: 'doctor', p_owner_id: detail.doctor_id }),
        supabase.rpc('is_currently_verified', { p_owner_type: 'clinic', p_owner_id: detail.clinic_id }),
      ]);
      setDoctorVerified(!!docVerified);
      setClinicVerified(!!clinicVerifiedData);
    }
  };

  const loadVisit = async () => {
    // .limit(1) instead of .maybeSingle(): defensive against any duplicate
    // visit rows left over from before VisitScreen.tsx started reusing the
    // existing visit instead of inserting a new one each save - maybeSingle
    // errors outright if more than one row matches.
    const { data } = await supabase
      .from('visits')
      .select('*, prescriptions(*)')
      .eq('appointment_id', appointmentId)
      .order('created_at', { ascending: false })
      .limit(1);
    setVisit((data ?? [])[0] as (Visit & { prescriptions: Prescription[] }) | undefined ?? null);
  };

  const loadQueue = async (doctorId: string, date: string) => {
    const { data } = await supabase.rpc('get_queue_status', { p_doctor_id: doctorId, p_date: date });
    setQueueRows((data ?? []) as QueueStatusRow[]);
  };

  // Accept/reject/reminder notices all land here with richer text than the
  // plain status label (queue position, reject reason + suggested next slot,
  // "up soon", "moved to the end of the queue"). Read the newest one for
  // this booking and surface it - deduped by id so the same notice doesn't
  // reappear every time an unrelated broadcast on the shared queue channel
  // fires (that channel carries every patient's updates for this doctor/date,
  // not just this booking's).
  const shownNotificationId = useRef<string | null>(null);
  const checkLatestNotification = async () => {
    if (!appointmentId) return;
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id;
    if (!uid) return;
    const { data } = await supabase
      .from('notifications')
      .select('id, message')
      .eq('appointment_id', appointmentId)
      .eq('user_id', uid)
      .order('at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data && data.id !== shownNotificationId.current) {
      shownNotificationId.current = data.id;
      setAlertMessage(data.message);
    }
  };

  useEffect(() => {
    if (!appointmentId) return;
    loadBooking();
    loadVisit();
    checkLatestNotification();
    // Paying online buys a more forgiving rescheduling window (a convenience,
    // not a queue advantage) - the clinic sets both figures.
    getCheckInOptions(appointmentId).then(setOptions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId]);

  // Estimate minutes-per-position from the doctor's working hours, so the
  // "~30 minutes away" alert and the wait estimate have something to base
  // themselves on.
  useEffect(() => {
    if (!booking) return;
    const weekday = new Date(booking.date + 'T00:00:00').getDay();
    supabase
      .from('doctor_availability')
      .select('*')
      .eq('doctor_id', booking.doctor_id)
      .eq('weekday', weekday)
      .then(({ data }) => setSlotMinutes(estimateSlotMinutes((data ?? []) as DoctorAvailability[])));
  }, [booking?.doctor_id, booking?.date]);

  useEffect(() => {
    if (!booking || !WATCHED_STATUSES.includes(booking.status)) return;

    let cancelled = false;
    loadQueue(booking.doctor_id, booking.date);

    supabase.realtime.setAuth();
    const channel = supabase
      .channel(`queue:${booking.doctor_id}:${booking.date}`)
      .on('broadcast', { event: 'UPDATE' }, () => {
        if (!cancelled) {
          loadQueue(booking.doctor_id, booking.date);
          loadVisit();
          loadBooking();
          checkLatestNotification();
        }
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking?.status, booking?.doctor_id, booking?.date]);

  // How many are genuinely in front of this patient, taken from the server's
  // ordering rather than by subtracting token numbers - under the fair-queue
  // rule (schema.sql section 31) a lower token does not mean an earlier turn.
  const nowServing = computeNowServing(queueRows);
  const aheadOfMe = countAhead(queueRows, booking?.token_number ?? null);

  // Fire the two in-app reminders once each, when their condition is first met.
  useEffect(() => {
    if (!booking || aheadOfMe == null) return;

    const raiseAlert = async (message: string) => {
      setAlertMessage(message);
      await supabase.from('notifications').insert({
        user_id: (await supabase.auth.getUser()).data.user?.id,
        type: 'queue_reminder',
        message,
        appointment_id: booking.id,
      });
    };

    if (aheadOfMe === 0 && !alerted.current.next) {
      alerted.current.next = true;
      raiseAlert("You're next! Please head to the clinic now.");
    } else if (aheadOfMe > 0 && aheadOfMe * slotMinutes <= 30 && !alerted.current.thirty) {
      alerted.current.thirty = true;
      raiseAlert('Your turn is about 30 minutes away.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aheadOfMe, booking?.id, slotMinutes]);

  if (loading) return <p className="p-6 text-slate-400">Loading...</p>;
  if (!booking) return <p className="p-6 text-slate-400">Booking not found.</p>;

  const confirmed = ['accepted', 'checked_in', 'called', 'in_consultation', 'completed'].includes(booking.status);
  // Holding a live token: arrived, not finished.
  const inQueue = ['checked_in', 'called', 'in_consultation'].includes(booking.status);
  // Confirmed but not yet through the door - the "you'll get your number when
  // you arrive" state, which is new in this model.
  const awaitingArrival = booking.status === 'accepted';
  const cancelWindowHours = options?.rescheduleWindowHours ?? DEFAULT_CANCEL_WINDOW_HOURS;
  const ahead = inQueue ? aheadOfMe : null;
  const estimatedWaitMinutes = ahead != null ? Math.round(ahead * slotMinutes) : 0;

  const bookingMoment = new Date(`${booking.date}T${booking.slot_time}`);
  const endMoment = new Date(bookingMoment.getTime() + slotMinutes * 60 * 1000);
  const canModify =
    ['booked', 'accepted'].includes(booking.status) &&
    bookingMoment.getTime() - Date.now() > cancelWindowHours * 60 * 60 * 1000;

  const cancelBooking = async () => {
    setActionError(null);
    const { error } = await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', booking.id);
    if (error) {
      setActionError(error.message);
      return;
    }
    loadBooking();
  };

  const rescheduleBooking = async () => {
    setActionError(null);
    const { error } = await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', booking.id);
    if (error) {
      setActionError(error.message);
      return;
    }
    navigate(`/doctors/${booking.doctor_id}`);
  };

  const mapsHref =
    booking.clinics?.lat != null && booking.clinics?.lng != null
      ? `https://www.google.com/maps/search/?api=1&query=${booking.clinics.lat},${booking.clinics.lng}`
      : null;

  return (
    <div>
      <ScreenHeader title="Appointment Details" back={-1} />

      <div className="mx-auto max-w-md px-4 py-4">
        {alertMessage && (
          <div className="mb-3 rounded-2xl bg-amber-50 p-3.5 text-sm font-medium text-amber-800">{alertMessage}</div>
        )}

        {/* Status + who/where */}
        <Card className="!p-0">
          <div className="p-4">
            <StatusPill
              label={STATUS_LABEL[booking.status]}
              tone={STATUS_TONE[booking.status]}
              icon={confirmed ? CheckCircle2 : undefined}
            />
            <div className="mt-3 flex items-start gap-3">
              <IconTile icon={CalendarDays} size="md" />
              <div>
                <p className="text-lg font-bold text-slate-900">
                  {new Date(booking.date + 'T00:00:00').toLocaleDateString(undefined, {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </p>
                <p className="text-sm font-bold text-brand-600">
                  {formatTimeLabel(booking.slot_time)} –{' '}
                  {endMoment.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3 border-t border-slate-100 p-4">
            <IconTile icon={Stethoscope} size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-base font-bold text-slate-900">{booking.doctors?.name ?? 'Doctor'}</p>
                <VerifiedBadge verified={doctorVerified} ownerType="doctor" />
              </div>
              <p className="text-sm font-medium text-brand-600">
                {booking.doctors?.specialty ?? 'General Physician'}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 border-t border-slate-100 p-4">
            <IconTile icon={MapPin} size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-base font-bold text-slate-900">{booking.clinics?.name ?? 'Clinic'}</p>
                <VerifiedBadge verified={clinicVerified} ownerType="clinic" />
              </div>
              <p className="text-sm text-slate-500">{booking.clinics?.address ?? '—'}</p>
              {mapsHref && (
                <a
                  href={mapsHref}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-sm font-bold text-brand-600"
                >
                  <MapPin size={14} /> Get Directions
                </a>
              )}
            </div>
          </div>
        </Card>

        {/* Booking facts */}
        <Card className="mt-3 !p-0">
          <div className="flex items-center gap-3 p-4">
            <IconTile icon={UserRound} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-slate-900">Appointment For</p>
              <p className="text-sm text-slate-500">{booking.family_members?.name ?? '—'}</p>
            </div>
            <span className="shrink-0 font-mono text-xs font-semibold text-slate-500">
              {booking.family_members?.mrn}
            </span>
          </div>

          <div className="flex items-center gap-3 border-t border-slate-100 p-4">
            <IconTile icon={QrCodeIcon} size="sm" />
            <p className="min-w-0 flex-1 text-sm font-bold text-slate-900">Booking reference</p>
            <span className="rounded-xl bg-brand-50 px-3 py-1.5 font-mono text-sm font-extrabold text-brand-700">
              {bookingReference(booking.id)}
            </span>
          </div>

          <div className="flex items-center gap-3 border-t border-slate-100 p-4">
            <IconTile icon={Clock} size="sm" />
            <p className="min-w-0 flex-1 text-sm font-bold text-slate-900">Duration</p>
            <span className="text-sm text-slate-500">{slotMinutes} mins</span>
          </div>

          {booking.reason && (
            <div className="flex items-center gap-3 border-t border-slate-100 p-4">
              <IconTile icon={CalendarClock} size="sm" />
              <p className="min-w-0 flex-1 text-sm font-bold text-slate-900">Purpose of Visit</p>
              <span className="max-w-[55%] truncate text-right text-sm text-slate-500">{booking.reason}</span>
            </div>
          )}

          {booking.encounters?.encounter_no && (
            <div className="flex items-center gap-3 border-t border-slate-100 p-4">
              <IconTile icon={QrCodeIcon} size="sm" tone="slate" />
              <p className="min-w-0 flex-1 text-sm font-bold text-slate-900">Encounter number</p>
              <span className="font-mono text-xs text-slate-500">{booking.encounters.encounter_no}</span>
            </div>
          )}
        </Card>

        {/* Confirmed, but the patient hasn't arrived yet - no token exists.
            The scannable code itself lives on the dedicated pass screen,
            which is what the patient holds up at the desk. */}
        {awaitingArrival && (
          <div className="mt-3 rounded-3xl border border-brand-100 bg-white p-5 text-center">
            {booking.sequence_no != null ? (
              <>
                <p className="text-sm font-semibold text-slate-500">Your number for the day</p>
                <p className="mt-1 text-5xl font-extrabold leading-none text-brand-600">#{booking.sequence_no}</p>
                {booking.estimated_time && (
                  <p className="mt-1.5 text-sm font-bold text-slate-700">
                    Expected around {formatTimeLabel(booking.estimated_time)}
                  </p>
                )}
                <p className="mt-2 text-xs text-slate-500">
                  This is your place in the published order, not a check-in. Tokens are still given out in arrival
                  order when you actually check in at the clinic.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-500">Your Token Number</p>
                <p className="mt-1 text-4xl font-extrabold leading-none text-slate-300">— —</p>
                <p className="mt-2 text-sm font-semibold text-slate-700">
                  You'll get your token when you check in at the clinic.
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Tokens are given out in arrival order on the day, so getting there on time is what secures your
                  place in the queue — not the time you booked.
                </p>
              </>
            )}
            <Button full className="mt-4" onClick={() => navigate(`/bookings/${booking.id}/pass`)}>
              <QrCodeIcon size={17} /> Show this at reception
            </Button>
            <div className="mt-4 text-left">
              <InfoNote
                title="When you arrive"
                bullets={[
                  `Check in at the desk from 60 minutes before your ${formatTimeLabel(booking.slot_time)} slot.`,
                  'Show your check-in code — or just give them your name, phone or MRN.',
                  'Your token number appears here as soon as the desk checks you in.',
                ]}
              />
            </div>
          </div>
        )}

        {/* Arrived - the live token. */}
        {inQueue && booking.token_number != null && (
          <div className="mt-3 rounded-3xl border border-brand-100 bg-white p-5 text-center">
            {booking.checked_in_at && (
              <div className="mb-3 flex items-center justify-center gap-2 rounded-2xl bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-700">
                <CheckCircle2 size={16} /> Checked in at{' '}
                {new Date(booking.checked_in_at).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </div>
            )}
            <p className="text-sm font-semibold text-slate-500">Your Token Number</p>
            <p className="mt-1 text-6xl font-extrabold leading-none text-brand-600">{booking.token_number}</p>
            <p className="mt-2 text-sm text-slate-500">
              {booking.status === 'in_consultation'
                ? 'You are with the doctor now.'
                : booking.status === 'called'
                  ? "It's your turn — please go in."
                  : 'Please wait for your number to be called.'}
            </p>

            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="rounded-2xl border border-slate-100 p-3">
                <span className="text-xs font-semibold text-slate-500">Now serving</span>
                <p className="mt-1 text-xl font-extrabold text-slate-900">{nowServing ?? '—'}</p>
              </div>
              <div className="rounded-2xl border border-slate-100 p-3">
                <div className="flex items-center justify-center gap-1.5 text-slate-500">
                  <Users size={15} />
                  <span className="text-xs font-semibold">Ahead</span>
                </div>
                <p className="mt-1 text-xl font-extrabold text-slate-900">{ahead ?? '—'}</p>
              </div>
              <div className="rounded-2xl border border-slate-100 p-3">
                <div className="flex items-center justify-center gap-1.5 text-slate-500">
                  <Clock size={15} />
                  <span className="text-xs font-semibold">Est. wait</span>
                </div>
                <p className="mt-1 text-xl font-extrabold text-slate-900">~{estimatedWaitMinutes}m</p>
              </div>
            </div>

            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              These update as people arrive. Turn order follows appointment time, then arrival.
            </p>

            <button
              onClick={() => loadQueue(booking.doctor_id, booking.date)}
              className="mx-auto mt-3 flex items-center gap-1.5 text-sm font-bold text-brand-600"
            >
              <RefreshCw size={14} /> Refresh status
            </button>

            <div className="mt-4 text-left">
              <InfoNote
                title="Important"
                bullets={[
                  'Please wait near the consultation area.',
                  "You'll be notified here when it's your turn.",
                  'Your token is fixed for today — it was issued in the order people arrived and does not move.',
                ]}
              />
            </div>
          </div>
        )}

        {booking.status === 'rejected' && booking.reject_reason && (
          <Card className="mt-3">
            <p className="text-sm text-slate-600">Reason: {booking.reject_reason}</p>
            <p className="mt-2 text-sm text-amber-600">
              If you paid online, your payment hold has been released automatically.
            </p>
          </Card>
        )}

        <ClinicLocationPreview
          lat={booking.clinics?.lat ?? null}
          lng={booking.clinics?.lng ?? null}
          formattedAddress={booking.clinics?.formatted_address ?? null}
          clinicName={booking.clinics?.name}
        />

        {booking.status === 'booked' && (
          <div className="mt-3">
            <InfoNote
              title="Important Information"
              bullets={[
                'Please arrive 15 minutes before your appointment time.',
                'Carry a valid ID proof and previous reports, if any.',
                `You can reschedule or cancel up to ${cancelWindowHours} hour${cancelWindowHours === 1 ? '' : 's'} before the appointment.`,
              ]}
            />
          </div>
        )}

        {actionError && <p className="mt-3 text-sm text-red-600">{actionError}</p>}

        {canModify && (
          <div className="mt-4 space-y-2">
            <Button full onClick={rescheduleBooking}>
              <CalendarClock size={17} /> Reschedule Appointment
            </Button>
            <Button variant="danger" full onClick={cancelBooking}>
              <Trash2 size={16} /> Cancel Appointment
            </Button>
          </div>
        )}
        {['booked', 'accepted'].includes(booking.status) && !canModify && (
          <p className="mt-3 text-center text-xs text-slate-400">
            Too close to the appointment time to cancel or reschedule (within {cancelWindowHours} hour{cancelWindowHours === 1 ? '' : 's'}).
          </p>
        )}

        <VisitDetails visit={visit} prescription={visit?.prescriptions[0] ?? null} />
        <FileUpload appointmentId={booking.id} memberId={booking.member_id} />
      </div>
    </div>
  );
}
