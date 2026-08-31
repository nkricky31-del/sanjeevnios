import { Clock, RefreshCw, Ticket, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import ClinicLocationPreview from '../components/ClinicLocationPreview';
import FileUpload from '../components/FileUpload';
import AppHeader from '../components/ui/AppHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import InfoBanner from '../components/ui/InfoBanner';
import StatTile from '../components/ui/StatTile';
import StatusPill from '../components/ui/StatusPill';
import VerifiedBadge from '../components/VerifiedBadge';
import VisitDetails from '../components/VisitDetails';
import { computeNowServing } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import { estimateSlotMinutes } from '../lib/time';
import type { AppointmentStatus, DoctorAvailability, Prescription, QueueStatusRow, Visit } from '../lib/types';

interface BookingDetail {
  id: string;
  member_id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  token_no: number | null;
  reject_reason: string | null;
  doctor_id: string;
  clinic_id: string;
  doctors: { name: string; specialty: string | null } | null;
  clinics: { name: string; lat: number | null; lng: number | null; formatted_address: string | null } | null;
  family_members: { name: string } | null;
  encounters: { encounter_no: string } | null;
}

// Statuses where something can still change - a rejected/cancelled/no_show
// booking is done, no point keeping a live channel open for it.
const LIVE_STATUSES: AppointmentStatus[] = ['pending', 'accepted', 'in_progress', 'done'];

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  pending: 'Pending clinic approval',
  accepted: 'You are in queue',
  rejected: 'Rejected by clinic',
  cancelled: 'Cancelled',
  in_progress: 'You are being seen now',
  done: 'Visit complete',
  no_show: 'Marked as no-show',
};

const STATUS_TONE: Record<AppointmentStatus, 'live' | 'warning' | 'info' | 'neutral'> = {
  pending: 'warning',
  accepted: 'live',
  in_progress: 'live',
  rejected: 'neutral',
  cancelled: 'neutral',
  done: 'info',
  no_show: 'neutral',
};

const CANCEL_WINDOW_HOURS = 2;

export default function BookingStatus() {
  const { appointmentId } = useParams<{ appointmentId: string }>();
  const navigate = useNavigate();
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [nowServing, setNowServing] = useState<number | null>(null);
  const [slotMinutes, setSlotMinutes] = useState(15);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [visit, setVisit] = useState<(Visit & { prescriptions: Prescription[] }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [doctorVerified, setDoctorVerified] = useState(false);
  const [clinicVerified, setClinicVerified] = useState(false);
  const alerted = useRef({ thirty: false, next: false });

  const loadBooking = async () => {
    const { data } = await supabase
      .from('appointments')
      .select(
        '*, doctors(name, specialty), clinics(name, lat, lng, formatted_address), family_members(name), encounters(encounter_no)'
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
    setNowServing(computeNowServing((data ?? []) as QueueStatusRow[]));
  };

  // Accept/reject/reminder notices all land here with richer text than the
  // plain status label (token number, reject reason + suggested next slot,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId]);

  // Estimate minutes-per-token from the doctor's working hours, so the
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
    if (!booking || !LIVE_STATUSES.includes(booking.status)) return;

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

  // Fire the two in-app reminders once each, when their condition is first met.
  useEffect(() => {
    if (!booking || booking.token_no == null || nowServing == null) return;
    const tokensAway = booking.token_no - nowServing;
    if (tokensAway < 0) return;

    const raiseAlert = async (message: string) => {
      setAlertMessage(message);
      await supabase.from('notifications').insert({
        user_id: (await supabase.auth.getUser()).data.user?.id,
        type: 'queue_reminder',
        message,
        appointment_id: booking.id,
      });
    };

    if (tokensAway === 1 && !alerted.current.next) {
      alerted.current.next = true;
      raiseAlert("You're next! Please head to the clinic now.");
    } else if (tokensAway * slotMinutes <= 30 && !alerted.current.thirty) {
      alerted.current.thirty = true;
      raiseAlert('Your turn is about 30 minutes away.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowServing, booking?.token_no, slotMinutes]);

  if (loading) return <p className="p-6 text-slate-400">Loading...</p>;
  if (!booking) return <p className="p-6 text-slate-400">Booking not found.</p>;

  const confirmed = ['accepted', 'in_progress', 'done'].includes(booking.status);
  const tokensAway = confirmed && booking.token_no != null && nowServing != null ? booking.token_no - nowServing : null;
  const estimatedWaitMinutes = tokensAway != null && tokensAway > 0 ? Math.round(tokensAway * slotMinutes) : 0;
  const queueStatusLabel = tokensAway == null ? 'Waiting' : tokensAway <= 0 ? 'Your turn' : 'Moving';

  const bookingMoment = new Date(`${booking.date}T${booking.slot_time}`);
  const canModify =
    ['pending', 'accepted'].includes(booking.status) &&
    bookingMoment.getTime() - Date.now() > CANCEL_WINDOW_HOURS * 60 * 60 * 1000;

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

  return (
    <div>
      <AppHeader
        title="SanjeevniOS"
        subtitle={booking.clinics?.name}
        pill={confirmed ? <StatusPill label="Live Queue" tone="live" /> : undefined}
        bellDot={!!alertMessage}
      />

      <div className="mx-auto max-w-md px-4 py-6">
        <p className="text-xs uppercase tracking-wide text-slate-400">Booking ID</p>
        <p className="font-mono text-sm text-slate-600">{booking.id}</p>
        {booking.encounters?.encounter_no && (
          <>
            <p className="mt-1.5 text-xs uppercase tracking-wide text-slate-400">Encounter number</p>
            <p className="font-mono text-sm text-slate-600">{booking.encounters.encounter_no}</p>
          </>
        )}

        {alertMessage && (
          <div className="mt-3 rounded-xl bg-amber-100 p-3 text-sm font-medium text-amber-800">{alertMessage}</div>
        )}

        {confirmed ? (
          <Card className="relative mt-4 overflow-hidden !rounded-3xl bg-gradient-to-b from-brand-50 via-white to-white text-center">
            <span className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Live
            </span>
            <span className="inline-block rounded-full bg-coral-100 px-3 py-1 text-xs font-bold text-coral-700">
              Your Token Number
            </span>
            <div className="mx-auto mt-4 flex h-36 w-36 items-center justify-center rounded-full border-[6px] border-brand-500 bg-white shadow-lg shadow-brand-200/60">
              <p className="text-5xl font-extrabold text-brand-700">{booking.token_no}</p>
            </div>
            <p className="mt-3 text-sm font-semibold text-slate-600">{STATUS_LABEL[booking.status]}</p>
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
              {booking.doctors?.name}
              <VerifiedBadge verified={doctorVerified} ownerType="doctor" />
              <VerifiedBadge verified={clinicVerified} ownerType="clinic" />
            </span>
          </Card>
        ) : (
          <Card className="mt-4 text-center">
            <StatusPill label={STATUS_LABEL[booking.status]} tone={STATUS_TONE[booking.status]} />
            <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-slate-500">
              {booking.doctors?.name} <VerifiedBadge verified={doctorVerified} ownerType="doctor" /> ·{' '}
              {booking.clinics?.name} <VerifiedBadge verified={clinicVerified} ownerType="clinic" />
            </p>
          </Card>
        )}

        <Card className="mt-3">
          <p className="text-sm text-slate-500">For: {booking.family_members?.name}</p>
          <p className="text-sm text-slate-500">
            {booking.date} at {booking.slot_time?.slice(0, 5)}
          </p>
          {booking.status === 'rejected' && (
            <>
              {booking.reject_reason && (
                <p className="mt-2 text-sm text-slate-600">Reason: {booking.reject_reason}</p>
              )}
              <p className="mt-2 text-sm text-amber-600">
                If you paid online, your payment hold has been released automatically.
              </p>
            </>
          )}
        </Card>

        <ClinicLocationPreview
          lat={booking.clinics?.lat ?? null}
          lng={booking.clinics?.lng ?? null}
          formattedAddress={booking.clinics?.formatted_address ?? null}
          clinicName={booking.clinics?.name}
        />

        {confirmed && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <StatTile icon={Ticket} label="Current token" value={nowServing ?? '—'} tone="brand" />
              <StatTile icon={Users} label="Patients before you" value={tokensAway != null ? Math.max(tokensAway, 0) : '—'} tone="amber" />
              <StatTile icon={Clock} label="Estimated wait" value={`~${estimatedWaitMinutes}m`} tone="slate" />
              <StatTile icon={RefreshCw} label="Queue status" value={queueStatusLabel} tone="emerald" />
            </div>

            <div className="mt-3 flex items-center justify-between px-2">
              <div className="text-center">
                <div className="mx-auto h-3 w-3 rounded-full bg-brand-600" />
                <p className="mt-1 text-xs font-semibold text-brand-700">{nowServing ?? '—'}</p>
                <p className="text-[11px] text-slate-400">Now serving</p>
              </div>
              <div className="h-px flex-1 bg-slate-200" />
              <div className="text-center">
                <div className="mx-auto h-3 w-3 rounded-full border-2 border-brand-300 bg-white" />
                <p className="mt-1 text-xs font-semibold text-slate-500">Up next</p>
              </div>
              <div className="h-px flex-1 bg-slate-200" />
              <div className="text-center">
                <div className="mx-auto h-3 w-3 rounded-full border-2 border-emerald-500 bg-white" />
                <p className="mt-1 text-xs font-semibold text-emerald-700">{booking.token_no}</p>
                <p className="text-[11px] text-slate-400">Your turn</p>
              </div>
            </div>

            <div className="mt-3">
              <InfoBanner>We'll alert you here when your turn is near.</InfoBanner>
            </div>
          </>
        )}

        {canModify && (
          <div className="mt-4">
            {actionError && <p className="mb-2 text-sm text-red-600">{actionError}</p>}
            <div className="flex gap-2">
              <Button onClick={rescheduleBooking}>Reschedule</Button>
              <Button variant="danger" onClick={cancelBooking}>
                Cancel booking
              </Button>
            </div>
          </div>
        )}
        {['pending', 'accepted'].includes(booking.status) && !canModify && (
          <p className="mt-3 text-xs text-slate-400">
            Too close to the appointment time to cancel or reschedule (within {CANCEL_WINDOW_HOURS} hours).
          </p>
        )}

        <VisitDetails visit={visit} prescription={visit?.prescriptions[0] ?? null} />
        <FileUpload appointmentId={booking.id} memberId={booking.member_id} />
      </div>
    </div>
  );
}
