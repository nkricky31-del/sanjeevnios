import { ArrowRight, CalendarClock, MapPin } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import SlotPicker from '../components/SlotPicker';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Loading from '../components/ui/Loading';
import ScreenHeader from '../components/ui/ScreenHeader';
import { useAuth } from '../lib/AuthContext';
import {
  isFullDayError,
  isPatientSameDoctorError,
  isPatientWithin4HoursError,
  isSameDayCutoffError,
  isSlotFullError,
  patientRuleMessage,
} from '../lib/bookingPolicy';
import { getCheckInOptions } from '../lib/checkIn';
import { appointmentRescheduledMessage, notifyPatient } from '../lib/notify';
import { bookingReference } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import type { AppointmentPaymentStatus, AppointmentStatus } from '../lib/types';

interface Booking {
  id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  payment_status: AppointmentPaymentStatus;
  doctor_id: string;
  clinic_id: string;
  doctors: { name: string; specialty: string | null } | null;
  clinics: { name: string; address: string | null } | null;
  family_members: { name: string } | null;
}

const dayLabel = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

const PAYMENT_NOTE: Partial<Record<AppointmentPaymentStatus, string>> = {
  paid_online: 'Paid online - your payment stays with this booking.',
  pay_at_clinic: 'Pay at the clinic, as before.',
  free_followup: 'Free follow-up - nothing to pay.',
  paid_at_clinic: 'Already paid at the clinic.',
};

function friendlyError(message: string): string {
  if (isSlotFullError(message)) return 'That time just filled up. Pick another time.';
  if (isSameDayCutoffError(message)) return 'That time is too soon now. Pick a later time.';
  if (isFullDayError(message)) return 'That day is fully booked. Pick another day.';
  if (isPatientSameDoctorError(message) || isPatientWithin4HoursError(message)) return patientRuleMessage(message);
  return message.replace(/^[A-Z_]+: /, '');
}

// Move an existing booking to another time with the same doctor - the booking
// itself moves (reschedule_appointment, migration 86), so its booking ID,
// payment, coupon and details stay with it. Nothing is cancelled.
export default function RescheduleBooking() {
  const { appointmentId } = useParams<{ appointmentId: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();
  const [booking, setBooking] = useState<Booking | null | undefined>(undefined);
  const [windowHours, setWindowHours] = useState(2);
  const [pick, setPick] = useState<{ date: string; slotTime: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-reads the calendar after a "that time just filled up".
  const [pickerKey, setPickerKey] = useState(0);
  // When the screen opened - enough precision for an hours-long window.
  const [openedAt] = useState(() => Date.now());

  useEffect(() => {
    if (!appointmentId) return;
    supabase
      .from('appointments')
      .select(
        'id, date, slot_time, status, payment_status, doctor_id, clinic_id, doctors(name, specialty), clinics(name, address), family_members(name)'
      )
      .eq('id', appointmentId)
      .maybeSingle()
      .then(({ data }) => setBooking((data as unknown as Booking | null) ?? null));
    getCheckInOptions(appointmentId).then((o) => {
      if (o) setWindowHours(o.rescheduleWindowHours);
    });
  }, [appointmentId]);

  if (booking === undefined) return <p className="p-6 text-slate-400"><Loading /></p>;
  if (booking === null) return <p className="p-6 text-slate-400">Appointment not found.</p>;

  const backToBooking = () => navigate(`/bookings/${booking.id}`);
  const slotStart = new Date(`${booking.date}T${booking.slot_time}`);
  const upcoming = booking.status === 'booked' || booking.status === 'accepted';
  const inTime = slotStart.getTime() - openedAt > windowHours * 3_600_000;
  const canMove = upcoming && inTime;

  const move = async () => {
    if (!pick) return;
    setError(null);
    setSaving(true);
    const { error: moveError } = await supabase.rpc('reschedule_appointment', {
      p_appointment_id: booking.id,
      p_date: pick.date,
      p_slot_time: pick.slotTime,
    });
    if (moveError) {
      setSaving(false);
      setError(friendlyError(moveError.message));
      if (isSlotFullError(moveError.message) || isSameDayCutoffError(moveError.message) || isFullDayError(moveError.message)) {
        setPick(null);
        setPickerKey((k) => k + 1);
      }
      return;
    }
    if (session) {
      await notifyPatient({
        userId: session.user.id,
        appointmentId: booking.id,
        type: 'appointment_rescheduled',
        message: appointmentRescheduledMessage(booking.doctors?.name ?? null, pick.date, pick.slotTime, bookingReference(booking.id)),
      });
    }
    setSaving(false);
    navigate(`/bookings/${booking.id}`, { replace: true });
  };

  return (
    <div>
      <ScreenHeader title="Reschedule appointment" back={`/bookings/${booking.id}`} />
      <div className="mx-auto max-w-3xl px-4 py-4">
        {/* The booking being moved */}
        <Card>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Current appointment</p>
          <p className="mt-1 text-base font-bold text-brand-700">
            {dayLabel(booking.date)} · {formatTimeLabel(booking.slot_time)}
          </p>
          <p className="mt-1 text-lg font-bold text-slate-900">{booking.doctors?.name ?? 'Doctor'}</p>
          <p className="text-sm text-slate-500">{booking.doctors?.specialty ?? 'General Physician'}</p>
          {booking.family_members?.name && (
            <p className="mt-1 text-sm font-medium text-slate-600">For {booking.family_members.name}</p>
          )}
          {booking.clinics && (
            <p className="mt-1 flex items-start gap-1 text-sm text-slate-500">
              <MapPin size={14} className="mt-0.5 shrink-0" aria-hidden />
              {booking.clinics.name}
              {booking.clinics.address ? `, ${booking.clinics.address}` : ''}
            </p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            Booking ID <span className="font-mono font-semibold text-slate-700">{bookingReference(booking.id)}</span>
            {PAYMENT_NOTE[booking.payment_status] ? ` · ${PAYMENT_NOTE[booking.payment_status]}` : ''}
          </p>
        </Card>

        {!canMove ? (
          <Card className="mt-3">
            <p className="text-sm font-semibold text-slate-900">This appointment can't be moved online</p>
            <p className="mt-1 text-sm text-slate-600">
              {!upcoming
                ? 'Only an upcoming appointment that you have not checked in for can be rescheduled.'
                : `It's within ${windowHours} hour${windowHours === 1 ? '' : 's'} of the appointment. Please contact the clinic to change it.`}
            </p>
            <Button className="mt-3" variant="secondary" onClick={backToBooking}>
              Back to the appointment
            </Button>
          </Card>
        ) : (
          <>
            <h2 className="mt-5 text-base font-bold text-slate-900">Pick a new time</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Same doctor and clinic. Your booking ID, payment and details move with it - nothing is cancelled.
            </p>
            <div className="mt-3">
              <SlotPicker
                key={pickerKey}
                doctorId={booking.doctor_id}
                clinicId={booking.clinic_id}
                selectedDate={pick?.date ?? null}
                selectedSlot={pick?.slotTime ?? null}
                initialDate={booking.date}
                current={{ date: booking.date, slotTime: booking.slot_time }}
                onSelect={(date, slotTime) => {
                  setError(null);
                  setPick({ date, slotTime });
                }}
              />
            </div>

            {error && (
              <p role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}

            {pick && (
              <Card className="mt-4">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Your new time</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-slate-500 line-through">
                    {dayLabel(booking.date)} · {formatTimeLabel(booking.slot_time)}
                  </span>
                  <ArrowRight size={16} className="text-slate-400" aria-label="to" />
                  <span className="font-bold text-slate-900">
                    {dayLabel(pick.date)} · {formatTimeLabel(pick.slotTime)}
                  </span>
                </div>
                <Button full className="mt-4" onClick={move} disabled={saving}>
                  <CalendarClock size={17} /> {saving ? 'Moving…' : 'Move my appointment'}
                </Button>
              </Card>
            )}

            <button
              type="button"
              onClick={backToBooking}
              className="mt-3 w-full text-center text-sm font-medium text-slate-500"
            >
              Keep the current time
            </button>
          </>
        )}
      </div>
    </div>
  );
}
