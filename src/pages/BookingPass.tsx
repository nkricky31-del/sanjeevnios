import { CheckCircle2, Clock, MapPin, QrCode as QrCodeIcon, RefreshCw, ScanLine, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import QrScanner from '../components/QrScanner';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import InfoNote from '../components/ui/InfoNote';
import QrCode from '../components/ui/QrCode';
import ScreenHeader from '../components/ui/ScreenHeader';
import StatusPill from '../components/ui/StatusPill';
import {
  getCheckInOptions,
  getCurrentCoords,
  issueBookingQr,
  looksLikeClinicQr,
  selfCheckIn,
  type CheckInOptions,
} from '../lib/checkIn';
import { bookingReference, computeNowServing, countAhead, findMyPosition } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import { estimateSlotMinutes, formatTimeLabel } from '../lib/time';
import { PAYMENT_STATUS_LABEL } from '../lib/types';
import type {
  AppointmentPaymentStatus,
  AppointmentStatus,
  DoctorAvailability,
  QueueStatusRow,
} from '../lib/types';

interface PassBooking {
  id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  payment_status: AppointmentPaymentStatus;
  token_number: number | null;
  checked_in_at: string | null;
  // The published running order (schema.sql section 34) - a PLAN, assigned
  // the night before to every booked patient. Separate from token_number,
  // which only exists once this patient has actually checked in.
  sequence_no: number | null;
  estimated_time: string | null;
  doctor_id: string;
  clinic_id: string;
  doctors: { name: string; specialty: string | null } | null;
  clinics: {
    name: string;
    address: string | null;
    self_checkin_enabled: boolean;
    self_checkin_require_location: boolean;
  } | null;
  family_members: { name: string; mrn: string } | null;
  encounters: { encounter_no: string } | null;
}

// Re-mint the signed code well before its 10-minute expiry, so the patient
// never ends up holding a stale one at the desk.
const QR_REFRESH_MS = 4 * 60 * 1000;

const LIVE_STATUSES: AppointmentStatus[] = ['checked_in', 'called', 'in_consultation'];

// "Show this at reception". Before arrival it's a signed, self-refreshing QR
// plus the booking's details; after check-in the same screen becomes the live
// token view - number, now serving, people ahead, rough wait - so the patient
// never has to work out which screen to be on.
export default function BookingPass() {
  const { appointmentId } = useParams<{ appointmentId: string }>();
  const [booking, setBooking] = useState<PassBooking | null>(null);
  const [loading, setLoading] = useState(true);
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [nowServing, setNowServing] = useState<number | null>(null);
  const [aheadCount, setAheadCount] = useState<number | null>(null);
  const [myPosition, setMyPosition] = useState<number | null>(null);
  const [slotMinutes, setSlotMinutes] = useState(15);
  const [scanning, setScanning] = useState(false);
  const [selfBusy, setSelfBusy] = useState(false);
  const [selfError, setSelfError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [options, setOptions] = useState<CheckInOptions | null>(null);
  const scanHandled = useRef(false);
  // Each near-turn alert fires once, not on every queue tick.
  const alerted = useRef({ thirty: false, next: false });

  const loadBooking = useCallback(async () => {
    if (!appointmentId) return;
    const { data } = await supabase
      .from('appointments')
      .select(
        'id, date, slot_time, status, payment_status, token_number, checked_in_at, sequence_no, estimated_time, doctor_id, clinic_id, doctors(name, specialty), clinics(name, address, self_checkin_enabled, self_checkin_require_location), family_members(name, mrn), encounters(encounter_no)'
      )
      .eq('id', appointmentId)
      .single();
    setBooking(data as unknown as PassBooking | null);
    setLoading(false);
  }, [appointmentId]);

  useEffect(() => {
    loadBooking();
  }, [loadBooking]);

  // Whether this patient can skip the counter, and how forgiving their
  // rescheduling window is. Both are conveniences that come with paying
  // online; neither touches where they stand in the queue.
  useEffect(() => {
    if (!appointmentId) return;
    getCheckInOptions(appointmentId).then(setOptions);
  }, [appointmentId]);

  // Mint a fresh signed code, and keep minting one every few minutes while
  // this screen is open.
  const refreshQr = useCallback(async () => {
    if (!appointmentId) return;
    const result = await issueBookingQr(appointmentId);
    if ('error' in result) {
      setQrError(result.error);
      setQr(null);
      return;
    }
    setQrError(null);
    setQr(result.code);
  }, [appointmentId]);

  const awaitingArrival = booking?.status === 'accepted';

  useEffect(() => {
    if (!awaitingArrival) return;
    refreshQr();
    const timer = setInterval(refreshQr, QR_REFRESH_MS);
    return () => clearInterval(timer);
  }, [awaitingArrival, refreshQr]);

  // Live queue numbers, once the patient is actually in the queue.
  const loadQueue = useCallback(async () => {
    if (!booking) return;
    const { data } = await supabase.rpc('get_queue_status', {
      p_doctor_id: booking.doctor_id,
      p_date: booking.date,
    });
    const rows = (data ?? []) as QueueStatusRow[];
    setNowServing(computeNowServing(rows));
    // Position and "ahead of you" both come from the server's ordering, not
    // from comparing token numbers - under the fair-queue rule a lower token
    // does not mean an earlier turn.
    setAheadCount(countAhead(rows, booking.token_number));
    setMyPosition(findMyPosition(rows, booking.token_number));
  }, [booking]);

  useEffect(() => {
    if (!booking || !LIVE_STATUSES.includes(booking.status)) return;
    loadQueue();

    supabase.realtime.setAuth();
    const channel = supabase
      .channel(`queue:${booking.doctor_id}:${booking.date}`)
      .on('broadcast', { event: 'UPDATE' }, () => {
        loadQueue();
        loadBooking();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [booking, loadQueue, loadBooking]);

  // The desk checking someone in doesn't touch this patient's own row in a
  // way the broadcast always covers, so poll gently while waiting too.
  useEffect(() => {
    if (!booking || !['accepted', ...LIVE_STATUSES].includes(booking.status)) return;
    const timer = setInterval(() => {
      loadBooking();
      if (LIVE_STATUSES.includes(booking.status)) loadQueue();
    }, 15000);
    return () => clearInterval(timer);
  }, [booking, loadBooking, loadQueue]);

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

  // "Your turn is near" alerts, fired once each as the queue moves toward
  // this patient. Written to notifications as well as shown here, so the
  // bell and the notifications page carry them like every other alert.
  useEffect(() => {
    if (!booking || booking.token_number == null || aheadCount == null) return;
    if (!LIVE_STATUSES.includes(booking.status)) return;

    const raiseAlert = async (message: string) => {
      setAlert(message);
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user?.id) return;
      await supabase.from('notifications').insert({
        user_id: userData.user.id,
        appointment_id: booking.id,
        type: 'queue_reminder',
        message,
      });
    };

    if (aheadCount === 0 && !alerted.current.next) {
      alerted.current.next = true;
      raiseAlert("You're next! Please head to the consultation area now.");
    } else if (aheadCount > 0 && aheadCount * slotMinutes <= 30 && !alerted.current.thirty) {
      alerted.current.thirty = true;
      raiseAlert(`Your turn is about ${aheadCount * slotMinutes} minutes away — ${aheadCount} ahead of you.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aheadCount, booking?.token_number, booking?.status, slotMinutes]);

  // Patient scanning reception's rotating code.
  const handleSelfScan = async (raw: string) => {
    if (scanHandled.current) return;
    if (!looksLikeClinicQr(raw)) {
      setSelfError("That isn't the clinic's check-in code. Scan the code on the screen at reception.");
      return;
    }
    scanHandled.current = true;
    setScanning(false);
    setSelfBusy(true);
    setSelfError(null);

    const coords = options?.requiresLocation ? await getCurrentCoords() : null;
    const result = await selfCheckIn(raw, coords);
    setSelfBusy(false);
    scanHandled.current = false;

    if (!result.ok) {
      setSelfError(result.error ?? 'Could not check in.');
      return;
    }
    await loadBooking();
  };

  if (loading) return <p className="p-6 text-slate-400">Loading...</p>;
  if (!booking) return <p className="p-6 text-slate-400">Booking not found.</p>;

  const inQueue = LIVE_STATUSES.includes(booking.status);
  const estimatedWait = aheadCount != null ? Math.round(aheadCount * slotMinutes) : null;
  const paidOnline = booking.payment_status === 'paid_online';
  const selfCheckInAvailable = awaitingArrival && !!options?.canSelfCheckIn;

  return (
    <div>
      <ScreenHeader title={inQueue ? 'Your token' : 'Show this at reception'} back={-1} />

      {scanning && (
        <QrScanner
          onScan={handleSelfScan}
          onClose={() => setScanning(false)}
          hint="Point the camera at the check-in code on the screen at reception."
        />
      )}

      <div className="mx-auto max-w-md px-4 py-4">
        {alert && (
          <div className="mb-3 rounded-2xl bg-amber-50 p-3.5 text-sm font-semibold text-amber-800">{alert}</div>
        )}

        {/* ---------------- Before arrival: the signed QR ---------------- */}
        {awaitingArrival && (
          <Card className="text-center">
            <StatusPill label="Not checked in yet" tone="warning" />

            {booking.sequence_no != null && (
              <div className="mt-3 rounded-2xl bg-brand-50 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">
                  Your number for the day
                </p>
                <p className="text-3xl font-extrabold leading-tight text-brand-700">#{booking.sequence_no}</p>
                {booking.estimated_time && (
                  <p className="mt-0.5 text-xs font-semibold text-slate-600">
                    Expected around {formatTimeLabel(booking.estimated_time)}
                  </p>
                )}
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  This is your place in the published order, not a check-in — scan or show the code below when you
                  arrive.
                </p>
              </div>
            )}

            <div className="mt-4 flex justify-center">
              {qr ? (
                <QrCode value={qr} size={220} className="ring-1 ring-slate-100" />
              ) : (
                <div className="flex h-[220px] w-[220px] items-center justify-center rounded-2xl bg-slate-50 text-sm text-slate-400">
                  {qrError ?? 'Preparing your code...'}
                </div>
              )}
            </div>

            {/* The two arrival stories. Paying online skips the COUNTER, not
                the queue - so the wording is about speed of check-in, never
                about being seen sooner. */}
            {paidOnline ? (
              <>
                <p className="mt-3 text-sm font-semibold text-slate-700">
                  {selfCheckInAvailable
                    ? 'Already paid — scan the reception code and you’re checked in'
                    : 'Already paid — one scan at the desk and you’re checked in'}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Nothing to pay at the counter, so there's no queue to stand in to check in.
                </p>
              </>
            ) : (
              <>
                <p className="mt-3 text-sm font-semibold text-slate-700">Show this code at the reception desk</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  You'll check in at the counter when you pay.
                </p>
              </>
            )}
            <p className="mt-1 text-xs text-slate-400">
              The code refreshes every few minutes for security — keep this screen open when you arrive.
            </p>
            <button
              onClick={refreshQr}
              className="mx-auto mt-2 flex items-center gap-1.5 text-xs font-bold text-brand-600"
            >
              <RefreshCw size={13} /> Refresh code
            </button>
          </Card>
        )}

        {/* ---------------- After check-in: the live token ---------------- */}
        {inQueue && (
          <Card className="text-center">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
              <CheckCircle2 size={14} /> Checked in
              {booking.checked_in_at &&
                ` at ${new Date(booking.checked_in_at).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit',
                })}`}
            </div>

            <p className="mt-4 text-sm font-semibold text-slate-500">Your token number</p>
            <p className="text-7xl font-extrabold leading-none text-brand-600">{booking.token_number}</p>

            <p className="mt-3 text-sm font-semibold text-slate-700">
              {booking.status === 'in_consultation'
                ? 'You are with the doctor now.'
                : booking.status === 'called'
                  ? "It's your turn — please go in."
                  : 'Please wait for your number to be called.'}
            </p>

            {/* Position in line is the number that actually answers "when am
                I seen". The token above is the patient's fixed identifier;
                under the fair-queue rule a lower token does not mean an
                earlier turn, so both are shown, labelled for what they are. */}
            <div className="mt-4 rounded-2xl bg-brand-50 p-3">
              <p className="flex items-center justify-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-700">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                Your position in line · live
              </p>
              <p className="text-3xl font-extrabold leading-tight text-brand-700">
                {myPosition != null ? `${myPosition}${myPosition === 1 ? ' — you’re next' : ''}` : '—'}
              </p>
              {/* Said plainly, because a number that moves is alarming unless
                  you know why it moves. */}
              <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
                This updates as people arrive. Turn order follows appointment time, then arrival.
              </p>
            </div>

            <div className="mt-2 grid grid-cols-3 gap-2">
              <div className="rounded-2xl border border-slate-100 p-3">
                <p className="text-[11px] font-semibold text-slate-500">Now serving</p>
                <p className="mt-0.5 text-2xl font-extrabold text-slate-900">{nowServing ?? '—'}</p>
              </div>
              <div className="rounded-2xl border border-slate-100 p-3">
                <div className="flex items-center justify-center gap-1 text-slate-500">
                  <Users size={12} />
                  <p className="text-[11px] font-semibold">Ahead</p>
                </div>
                <p className="mt-0.5 text-2xl font-extrabold text-slate-900">{aheadCount ?? '—'}</p>
              </div>
              <div className="rounded-2xl border border-slate-100 p-3">
                <div className="flex items-center justify-center gap-1 text-slate-500">
                  <Clock size={12} />
                  <p className="text-[11px] font-semibold">Est. wait</p>
                </div>
                <p className="mt-0.5 text-2xl font-extrabold text-slate-900">
                  {estimatedWait != null ? `${estimatedWait}m` : '—'}
                </p>
              </div>
            </div>

            <button
              onClick={() => {
                loadBooking();
                loadQueue();
              }}
              className="mx-auto mt-3 flex items-center gap-1.5 text-xs font-bold text-brand-600"
            >
              <RefreshCw size={13} /> Refresh
            </button>
          </Card>
        )}

        {/* Neither waiting to arrive nor in the queue */}
        {!awaitingArrival && !inQueue && (
          <Card className="text-center">
            <StatusPill label={booking.status.replace(/_/g, ' ')} tone="neutral" />
            <p className="mt-3 text-sm text-slate-500">
              {booking.status === 'booked'
                ? "This booking is still waiting for the clinic to confirm it. You'll get a code to show once it's accepted."
                : 'There is no check-in code for this booking.'}
            </p>
          </Card>
        )}

        {/* ---------------- Booking details ---------------- */}
        <Card className="mt-3 !p-0">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm text-slate-500">Booking ID</span>
            <span className="font-mono text-sm font-bold text-slate-900">{bookingReference(booking.id)}</span>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
            <span className="text-sm text-slate-500">Patient</span>
            <span className="min-w-0 truncate text-sm font-semibold text-slate-900">
              {booking.family_members?.name}
              {booking.family_members?.mrn && (
                <span className="ml-1 font-mono text-xs text-slate-400">{booking.family_members.mrn}</span>
              )}
            </span>
          </div>
          <div className="flex items-start justify-between gap-3 border-t border-slate-100 px-4 py-3">
            <span className="shrink-0 text-sm text-slate-500">Clinic</span>
            <span className="min-w-0 text-right">
              <span className="block truncate text-sm font-semibold text-slate-900">{booking.clinics?.name}</span>
              {booking.clinics?.address && (
                <span className="block truncate text-xs text-slate-400">
                  <MapPin size={11} className="mr-0.5 inline" />
                  {booking.clinics.address}
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
            <span className="text-sm text-slate-500">Date &amp; slot</span>
            <span className="text-sm font-semibold text-slate-900">
              {new Date(booking.date + 'T00:00:00').toLocaleDateString(undefined, {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}{' '}
              · {formatTimeLabel(booking.slot_time)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
            <span className="text-sm text-slate-500">Doctor</span>
            <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{booking.doctors?.name}</span>
          </div>

          {booking.encounters?.encounter_no && (
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
              <span className="text-sm text-slate-500">Visit ID</span>
              <span className="font-mono text-xs font-semibold text-slate-500">
                {booking.encounters.encounter_no}
              </span>
            </div>
          )}

          {/* Payment sits here as its own, separate fact. It is deliberately
              NOT part of the check-in status above: paying online doesn't put
              anyone in the queue. See schema.sql section 30. */}
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
            <span className="text-sm text-slate-500">Payment</span>
            <span className="flex items-center gap-2">
              <StatusPill
                label={PAYMENT_STATUS_LABEL[booking.payment_status]}
                tone={
                  booking.payment_status === 'pay_at_clinic'
                    ? 'warning'
                    : booking.payment_status === 'refunded'
                      ? 'neutral'
                      : 'live'
                }
              />
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
            <span className="text-sm text-slate-500">Checked in</span>
            <span className="text-sm font-semibold text-slate-900">
              {booking.checked_in_at
                ? new Date(booking.checked_in_at).toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })
                : 'Not yet'}
            </span>
          </div>
        </Card>

        {booking.payment_status === 'paid_online' && awaitingArrival && (
          <p className="mt-2 px-1 text-xs leading-relaxed text-slate-500">
            You've already paid, so there's nothing to hand over at the desk — but you still need to check in when
            you arrive. Your place in the queue comes from arriving, not from paying.
          </p>
        )}

        {/* ---------------- Self check-in / fast lane ---------------- */}
        {selfCheckInAvailable && (
          <div className="mt-3">
            <Button full onClick={() => setScanning(true)} disabled={selfBusy}>
              <ScanLine size={17} />
              {selfBusy ? 'Checking you in...' : paidOnline ? 'Fast check-in — skip the counter' : 'Scan reception code to check in'}
            </Button>
            {selfError && <p className="mt-2 text-sm text-red-600">{selfError}</p>}
            <p className="mt-1.5 text-center text-xs text-slate-400">
              {paidOnline
                ? 'Because you paid online, you can check yourself in by scanning the code at reception'
                : 'This clinic lets you check yourself in by scanning the code displayed at reception'}
              {options?.requiresLocation ? ', while you are at the clinic' : ''}. It puts you in the queue at the
              time you arrive — it doesn't move you up it.
            </p>
          </div>
        )}

        {awaitingArrival && (
          <div className="mt-3">
            <InfoNote
              title="When you arrive"
              bullets={[
                'Check in at the desk from 60 minutes before your slot.',
                'Show the code above, or just give your name, phone or MRN.',
                'Your token number appears on this screen the moment you are checked in.',
                <>
                  Tokens are handed out in <strong>arrival order</strong>, so arriving on time is what secures your
                  place — not the time you booked.
                </>,
              ]}
            />
          </div>
        )}

        {!awaitingArrival && !inQueue && booking.status === 'booked' && (
          <div className="mt-3">
            <InfoNote>
              <span className="flex items-center gap-1.5">
                <QrCodeIcon size={13} /> Your check-in code appears here once the clinic accepts the booking.
              </span>
            </InfoNote>
          </div>
        )}
      </div>
    </div>
  );
}
