import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { useAuth } from '../lib/AuthContext';
import { getDayAvailability, isFullDayError, isSlotFullError, joinWaitlist, type DayAvailability } from '../lib/bookingPolicy';
import { addDaysISO, dobFromAge, isMinorDob, todayISO } from '../lib/date';
import { livePhoneDigits, normalizePhone } from '../lib/phone';
import { appointmentConfirmedMessage, notifyPatient } from '../lib/notify';
import { bookingReference, findNextBestSlot, findWalkInSlot } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import { computeSlots, formatTimeLabel } from '../lib/time';
import type { CheckInResult, DoctorAvailability, Gender, PatientType, PaymentMethod } from '../lib/types';
import SlotPicker from './SlotPicker';

interface DoctorOption {
  id: string;
  name: string;
  consultation_fee: number;
}

interface Props {
  clinicId: string;
  doctors: DoctorOption[];
  defaultDoctorId: string;
  /** False for an appointment-only clinic with no same-day booking: only "Book appointment" is offered. */
  walkInAllowed?: boolean;
  onAdded: () => void;
  onCancel: () => void;
}

interface BookingOutcome {
  bookingId: string;
  /** Only today's walk-in gets one - a future booking has no token yet. */
  token: number | null;
}

interface WaitlistOutcome {
  place: number;
}

interface AddedResult {
  today: BookingOutcome | WaitlistOutcome | null;
  /** Whether the patient has their own app account that the confirmation could reach. */
  notified: boolean;
  mrn: string;
  matchedExisting: boolean;
  future: (BookingOutcome & { date: string; slotTime: string }) | null;
}

function isWaitlistOutcome(o: BookingOutcome | WaitlistOutcome | null): o is WaitlistOutcome {
  return o !== null && 'place' in o;
}

// Runs the "insert booked -> accept -> record payment" sequence used for both
// today's walk-in visit and an optional future booking made in the same flow,
// with every step's error actually checked and surfaced (see the try/catch in
// submit() below for the other half of that - a thrown/rejected promise, e.g.
// from a network or Supabase URL misconfiguration, used to leave the form
// stuck on "Adding..." with no error shown at all).
//
// A walk-in patient is, by definition, standing at the desk - so once the
// appointment is accepted this also checks them in, which is what actually
// draws their token from the clinic's arrival counter (see
// check_in_appointment() in schema.sql section 27). A FUTURE appointment
// booked through this same form gets no token: that patient will collect one
// when they arrive on the day, like anyone else.
//
// collectNow (only meaningful alongside checkInNow) is the desk actually
// taking payment at registration, not just noting how they'll eventually
// pay: 'online' records it exactly like a patient's own paid-online booking
// (schema.sql section 30), and 'cod' takes the cash and immediately calls
// mark_paid_at_clinic() (section 30.4) - the same call the "Mark paid"
// button on the queue makes - so this booking never sits around showing as
// still owed. A future booking never collects now; it stays pay_at_clinic
// until the patient actually arrives, like any other advance booking.
async function createAndAcceptAppointment(params: {
  memberId: string;
  doctorId: string;
  clinicId: string;
  date: string;
  slotTime: string;
  reason: string | null;
  consultationFee: number;
  patientType: PatientType;
  checkInNow: boolean;
  collectNow?: PaymentMethod;
}): Promise<BookingOutcome | { error: string }> {
  const { data: appointment, error: apptError } = await supabase
    .from('appointments')
    .insert({
      member_id: params.memberId,
      doctor_id: params.doctorId,
      clinic_id: params.clinicId,
      date: params.date,
      slot_time: params.slotTime,
      reason: params.reason,
      status: 'booked',
      payment_status: params.collectNow === 'online' ? 'paid_online' : 'pay_at_clinic',
      patient_type: params.patientType,
    })
    .select('id')
    .single();
  if (apptError || !appointment) {
    return { error: apptError?.message ?? 'Could not add to the queue.' };
  }

  const { error: acceptError } = await supabase
    .from('appointments')
    .update({ status: 'accepted' })
    .eq('id', appointment.id);
  if (acceptError) {
    return { error: acceptError.message };
  }

  let token: number | null = null;
  if (params.checkInNow) {
    const { data: checkInData, error: checkInError } = await supabase.rpc('check_in_appointment', {
      p_appointment_id: appointment.id,
      p_method: 'manual',
    });
    if (checkInError) {
      return { error: `Registered, but check-in failed: ${checkInError.message}` };
    }
    token = ((checkInData ?? []) as CheckInResult[])[0]?.token_number ?? null;
    if (token == null) {
      return { error: 'Registered, but no token came back from check-in - please check the queue.' };
    }
  }

  const { error: paymentError } = await supabase.from('payments').insert({
    appointment_id: appointment.id,
    amount: params.consultationFee,
    method: params.collectNow === 'online' ? 'online' : 'cod',
    status: params.collectNow === 'online' ? 'captured' : 'pending',
  });
  if (paymentError) {
    // The appointment itself is booked (and, for a walk-in, checked in with
    // a token) - a missing payment row is a billing-desk problem, not a
    // reason to tell the front desk the registration failed. Surfaced as a
    // warning rather than swallowed outright.
    return {
      error: `Registered${token != null ? ` (token #${token})` : ''}, ref ${bookingReference(appointment.id)} — but the payment record failed to save: ${paymentError.message}`,
    };
  }

  if (params.collectNow === 'cod') {
    const { error: markPaidError } = await supabase.rpc('mark_paid_at_clinic', { p_appointment_id: appointment.id });
    if (markPaidError) {
      return {
        error: `Registered${token != null ? ` (token #${token})` : ''}, ref ${bookingReference(appointment.id)} — but marking the cash payment collected failed: ${markPaidError.message}`,
      };
    }
  }

  return { bookingId: appointment.id, token };
}

// What today looks like for this doctor right now - whether a walk-in can be
// seated at all, and into which exact slot. Recomputed whenever the doctor
// (or the clinic) changes; see schema.sql section 38 for why a walk-in now
// has to claim a real slot instead of just the clock.
interface Availability {
  dayInfo: DayAvailability | null;
  hasWindows: boolean;
  slotTime: string | null;
  /** Every slot today with whether it is still free - shown so the desk can see availability. */
  slots: { time: string; free: boolean }[];
}

export default function WalkInForm({ clinicId, doctors, defaultDoctorId, walkInAllowed = true, onAdded, onCancel }: Props) {
  const { session } = useAuth();
  const [doctorId, setDoctorId] = useState(defaultDoctorId);
  // 'walkin' = standing at the desk now; 'booking' = the clinic booking a slot
  // for someone who phoned in (or any later date) on the patient's behalf.
  const [mode, setMode] = useState<'walkin' | 'booking'>(walkInAllowed ? 'walkin' : 'booking');
  const [name, setName] = useState('');
  const [phoneDigits, setPhoneDigits] = useState('');
  const [mrn, setMrn] = useState('');
  const [govtId, setGovtId] = useState('');
  const [reason, setReason] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cod');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<Gender | ''>('');
  const [guardianConsent, setGuardianConsent] = useState(false);
  const [bookFuture, setBookFuture] = useState(false);
  const [futureDate, setFutureDate] = useState<string | null>(null);
  const [futureSlot, setFutureSlot] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AddedResult | null>(null);

  const [availability, setAvailability] = useState<Availability | null>(null);
  const [availLoading, setAvailLoading] = useState(true);
  // undefined = not checked yet, 'loading' = checking, null = checked and
  // nothing found within the search window, a date string = found.
  const [nextDay, setNextDay] = useState<string | null | 'loading' | undefined>(undefined);

  const ageNum = age ? Number(age) : null;
  const dob = ageNum != null && ageNum >= 0 ? dobFromAge(ageNum) : null;
  const minor = dob ? isMinorDob(dob) : false;
  const doctor = doctors.find((d) => d.id === doctorId);

  // Is there a slot for THIS doctor, right now? Checked fresh whenever the
  // doctor changes - the day cap (schema.sql section 33.3/38.2) and per-slot
  // capacity (section 36/38.1) are both live counts, never cached, so this
  // is only ever a snapshot: the actual insert below re-checks both
  // atomically and is the real authority if the answer changed in between.
  const loadAvailability = useCallback(async () => {
    if (!doctorId) return;
    setAvailLoading(true);
    setNextDay(undefined);
    const today = todayISO();
    const weekday = new Date().getDay();

    // Fetched as two groups rather than one flat Promise.all: mixing raw
    // Supabase query results with getDayAvailability()'s already-unwrapped
    // return in one destructure confuses the tuple's inferred type, so the
    // day check is kept separate.
    const [availRes, takenRes, clinicRes] = await Promise.all([
      supabase.from('doctor_availability').select('*').eq('doctor_id', doctorId),
      supabase.rpc('get_taken_slots', { p_doctor_id: doctorId, p_date: today }),
      supabase.from('clinics').select('checkin_grace_minutes').eq('id', clinicId).maybeSingle(),
    ]);
    const dayInfo = await getDayAvailability(clinicId, today);

    const windows = ((availRes.data ?? []) as DoctorAvailability[]).filter((a) => a.weekday === weekday);
    const allSlots = computeSlots(windows);
    const taken = new Set(((takenRes.data ?? []) as { slot_time: string }[]).map((r) => r.slot_time));
    const grace = (clinicRes.data as { checkin_grace_minutes: number } | null)?.checkin_grace_minutes ?? 30;
    const nowHHMMSS = new Date().toTimeString().slice(0, 8);

    setAvailability({
      dayInfo,
      hasWindows: windows.length > 0,
      slotTime: dayInfo?.isFull ? null : findWalkInSlot(allSlots, taken, nowHHMMSS, grace),
      slots: Array.from(new Set(allSlots)).map((t) => ({ time: t, free: !taken.has(t) && t >= nowHHMMSS })),
    });
    setAvailLoading(false);
  }, [doctorId, clinicId]);

  useEffect(() => {
    loadAvailability();
  }, [loadAvailability]);

  // Lazily, only once we know today's a dead end for this doctor - walking
  // forward a week of slot grids isn't free, so it's not worth doing until
  // there's actually a "no slot" screen that needs it.
  const loadNextDay = useCallback(async () => {
    if (!doctorId) return;
    setNextDay('loading');
    const found = await findNextBestSlot(doctorId, addDaysISO(todayISO(), 1));
    setNextDay(found?.date ?? null);
  }, [doctorId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!session) return;

    // A new patient must be registered with their name exactly as on their
    // Aadhaar and a mobile number (that number is how they get their booking
    // details and later log in). An existing patient picked by MRN needs neither.
    if (!mrn.trim() && !name.trim()) {
      setError('Enter the patient name as per Aadhaar, or their MRN if they already have one.');
      return;
    }
    if (!mrn.trim() && !phoneDigits) {
      setError('Mobile number is required to register a patient.');
      return;
    }
    if (!doctorId) {
      setError('Select a doctor.');
      return;
    }
    if (phoneDigits && !normalizePhone(phoneDigits)) {
      setError('Phone number must be 10 digits.');
      return;
    }
    if (age && (ageNum == null || Number.isNaN(ageNum) || ageNum < 0 || ageNum > 130)) {
      setError('Enter a valid age.');
      return;
    }
    if (minor && !guardianConsent) {
      setError("This patient is under 18 - confirm a parent/guardian is present and consents to this visit.");
      return;
    }
    if (mode === 'booking' && (!futureDate || !futureSlot)) {
      setError('Pick a day and a time slot for the appointment.');
      return;
    }
    if (mode === 'walkin' && bookFuture && (!futureDate || !futureSlot)) {
      setError('Pick a date and time for the future appointment, or uncheck "Also book a future appointment".');
      return;
    }

    setSaving(true);
    try {
      const normalizedPhone = phoneDigits ? normalizePhone(phoneDigits) : null;
      let memberId = '';
      let patientMrn = '';
      let matchedExisting = false;

      // MRN, if given, names one specific existing patient - it's checked
      // first and treated as an error to fix (not a cue to register someone
      // new) when it doesn't resolve. See find_family_member_by_mrn() in
      // schema.sql section 38.4.
      if (mrn.trim()) {
        const { data: byMrn, error: mrnError } = await supabase.rpc('find_family_member_by_mrn', {
          p_mrn: mrn.trim(),
        });
        if (mrnError) {
          setSaving(false);
          setError(`Could not look up that MRN: ${mrnError.message}`);
          return;
        }
        const match = (byMrn ?? [])[0] as { id: string; mrn: string; name: string } | undefined;
        if (!match) {
          setSaving(false);
          setError(`No patient found with MRN "${mrn.trim()}" - check the number, or clear it to register a new patient.`);
          return;
        }
        memberId = match.id;
        patientMrn = match.mrn;
        matchedExisting = true;
      } else if (normalizedPhone) {
        // If this phone number already belongs to a patient (their own
        // account, or a walk-in stub from any clinic), attach this visit to
        // THAT record instead of creating a duplicate one - see
        // find_family_member_by_phone() in migration_25_walkin_fixes.sql for
        // why this has to be a security-definer RPC rather than a plain
        // select (plain RLS can't see this row until an appointment already
        // links it to this clinic, which is exactly what we're about to create).
        const { data: existing, error: lookupError } = await supabase.rpc('find_family_member_by_phone', {
          p_phone: normalizedPhone,
        });
        if (lookupError) {
          setSaving(false);
          setError(`Could not check for an existing patient: ${lookupError.message}`);
          return;
        }
        const match = (existing ?? [])[0] as { id: string; mrn: string; name: string } | undefined;
        if (match) {
          memberId = match.id;
          patientMrn = match.mrn;
          matchedExisting = true;
        }
      }

      if (!matchedExisting) {
        if (!name.trim()) {
          setSaving(false);
          setError('Enter the patient name to register a new patient.');
          return;
        }
        // A walk-in has no patient account of their own yet. Modeled as a
        // "family member" owned by the CLINIC's own account, relation 'self'
        // since it's the walk-in patient themselves - purely so the booking
        // has someone to attach to, same as every other appointment in this
        // app. Storing the phone in the SAME normalized format Login.tsx
        // sends to Supabase Auth ('91' + 10 digits, no '+') is what lets
        // claim_walk_in_records() match it exactly once this person
        // eventually signs in for real.
        const { data: member, error: memberError } = await supabase
          .from('family_members')
          .insert({
            account_id: session.user.id,
            name: name.trim(),
            relation: 'self',
            phone: normalizedPhone,
            gender: gender || null,
            dob,
            govt_id: govtId.trim() || null,
            guardian_consent: guardianConsent,
          })
          .select('id, mrn')
          .single();
        if (memberError || !member) {
          setSaving(false);
          setError(memberError?.message ?? 'Could not register the patient.');
          return;
        }
        memberId = member.id;
        patientMrn = member.mrn;
      }

      // What "today" resolves to. If a slot was open when the form loaded,
      // try to book it - the insert re-checks both caps atomically, so a
      // slot that filled up in the meantime still comes back as a clean
      // refusal (SLOT_FULL/FULL_DAY) rather than a silent overbooking.
      let today: BookingOutcome | WaitlistOutcome | null = null;
      if (mode === 'booking') {
        // Booking on the patient's behalf: no walk-in handling at all - only the
        // chosen slot below.
      } else if (availability?.slotTime) {
        const bookedResult = await createAndAcceptAppointment({
          memberId,
          doctorId,
          clinicId,
          date: todayISO(),
          slotTime: availability.slotTime,
          reason: reason.trim() || null,
          consultationFee: doctor?.consultation_fee ?? 0,
          patientType: 'walk_in',
          checkInNow: true,
          collectNow: paymentMethod,
        });
        if ('error' in bookedResult) {
          if (isFullDayError(bookedResult.error) || isSlotFullError(bookedResult.error)) {
            // Lost the race for the last seat between the check above and
            // this insert - fall back to the waitlist instead of a dead end.
            const waitlisted = await joinWaitlist(clinicId, memberId, todayISO(), doctorId);
            if (waitlisted.error) {
              setSaving(false);
              setError(`That slot just filled up, and joining the waitlist also failed: ${waitlisted.error}`);
              return;
            }
            today = { place: waitlisted.place ?? 0 };
            loadAvailability();
          } else {
            setSaving(false);
            setError(bookedResult.error);
            return;
          }
        } else {
          today = bookedResult;
        }
      } else {
        const waitlisted = await joinWaitlist(clinicId, memberId, todayISO(), doctorId);
        if (waitlisted.error) {
          setSaving(false);
          setError(waitlisted.error);
          return;
        }
        today = { place: waitlisted.place ?? 0 };
      }

      let future: AddedResult['future'] = null;
      if ((mode === 'booking' || bookFuture) && futureDate && futureSlot) {
        // 'scheduled', not 'walk_in', and NOT checked in: this is a genuine
        // future slot, not someone standing at the desk right now. They'll
        // collect a token when they arrive on the day, like anyone else.
        const futureResult = await createAndAcceptAppointment({
          memberId,
          doctorId,
          clinicId,
          date: futureDate,
          slotTime: futureSlot,
          reason: reason.trim() || null,
          consultationFee: doctor?.consultation_fee ?? 0,
          patientType: 'scheduled',
          checkInNow: false,
        });
        if ('error' in futureResult) {
          // Today's outcome is already settled at this point - don't lose
          // that, just report the future booking failed.
          if (mode === 'booking') {
            // Nothing else happened in this flow, so this is a plain failure -
            // stay on the form (keeping what was typed) instead of a success screen.
            setError(
              isSlotFullError(futureResult.error)
                ? 'That time was just taken - pick another slot.'
                : `Could not book the appointment: ${futureResult.error.replace(/^[A-Z_]{5,}:\s*/, '')}`
            );
            setSaving(false);
            return;
          }
          setError(
            isSlotFullError(futureResult.error)
              ? "Today's visit was handled, but that future time just filled up - open Add walk-in again and pick another slot."
              : `Today's visit was handled, but the future appointment could not be booked: ${futureResult.error}`
          );
          setSaving(false);
          setResult({ today, notified: false, mrn: patientMrn, matchedExisting, future: null });
          return;
        }
        future = { ...futureResult, date: futureDate, slotTime: futureSlot };
      }

      // Send the booking details to the patient - in-app notice plus WhatsApp
      // when configured (see lib/notify.ts). Only possible when the patient
      // already has their own app account: a brand-new walk-in is stored under
      // the clinic's account until they sign in with this phone number, so
      // there's nobody to message yet.
      let notified = false;
      const bookedId = future?.bookingId ?? (today && !isWaitlistOutcome(today) ? today.bookingId : null);
      const bookedSlot = future?.slotTime ?? availability?.slotTime ?? null;
      if (bookedId && bookedSlot) {
        // The clinic can't read family_members directly (migration 68) - the
        // front-desk contact lookup is the permitted way to find who owns the
        // record, and works now that this clinic has an appointment for them.
        const { data: owner } = await supabase.rpc('get_patient_contacts', { p_ids: [memberId] });
        const accountId = ((owner ?? []) as { account_id: string }[])[0]?.account_id;
        if (accountId && accountId !== session.user.id) {
          const { data: clinicRow } = await supabase.from('clinics').select('report_before_minutes').eq('id', clinicId).maybeSingle();
          const bookedDate = future?.date ?? todayISO();
          const base = appointmentConfirmedMessage(bookedSlot, bookingReference(bookedId), 'pay_at_clinic', (clinicRow as { report_before_minutes: number } | null)?.report_before_minutes ?? 30);
          await notifyPatient({
            userId: accountId,
            appointmentId: bookedId,
            type: 'appointment_confirmed',
            message: `${doctor?.name ?? 'Your doctor'} on ${bookedDate}: ${base}`,
          });
          notified = true;
        }
      }

      setSaving(false);
      setResult({ today, notified, mrn: patientMrn, matchedExisting, future });
      onAdded();
    } catch (err) {
      // Anything that THROWS rather than resolving to {error} - a network
      // failure, a misconfigured Supabase URL/key for this environment,
      // etc. Without this catch, the promise rejection was unhandled: the
      // form stayed stuck on "Adding...", no error ever appeared, and the
      // walk-in silently never happened. This is the one failure mode the
      // per-call error checks above can't catch on their own.
      setSaving(false);
      setError(err instanceof Error ? `Unexpected error: ${err.message}` : 'Unexpected error - please try again.');
    }
  };

  if (result) {
    const doctorName = doctors.find((d) => d.id === doctorId)?.name ?? 'the doctor';
    const today = result.today;
    const todayWaitlisted = isWaitlistOutcome(today);
    return (
      <div
        className={`mt-3 rounded-xl border p-4 text-sm ${
          todayWaitlisted ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'
        }`}
      >
        {today === null ? (
          <p className="font-semibold">Appointment booked for {doctorName} on the patient's behalf.</p>
        ) : isWaitlistOutcome(today) ? (
          <>
            <p className="font-semibold">No slot was free for {doctorName} today - added to the waitlist instead.</p>
            <p className="mt-2 text-center text-3xl font-extrabold text-amber-700">#{today.place}</p>
            <p className="mt-1 text-center text-xs text-amber-700">Place in line - notified first if a seat opens up.</p>
          </>
        ) : (
          <>
            <p className="font-semibold">Checked in to today's queue for {doctorName}.</p>
            {today.token != null && (
              <p className="mt-2 text-center text-4xl font-extrabold text-emerald-700">#{today.token}</p>
            )}
            <p className="mt-1 text-center text-xs text-emerald-700">
              Token number — issued in arrival order and fixed for the rest of the day.
            </p>
            <p className="mt-2">
              Booking reference: <span className="font-mono font-semibold">{bookingReference(today.bookingId)}</span>
            </p>
            <p className="mt-1">
              Payment collected — {paymentMethod === 'online' ? 'online' : 'cash'}, ₹{doctor?.consultation_fee ?? 0}.
            </p>
          </>
        )}
        <p className="mt-1 font-mono text-xs opacity-80">Medical record number: {result.mrn}</p>
        {result.matchedExisting && <p className="mt-1 opacity-80">Matched to an existing patient record - no duplicate created.</p>}
        {result.future && (
          <p className="mt-1">
            Future appointment booked for {result.future.date} at {formatTimeLabel(result.future.slotTime)} — ref{' '}
            {bookingReference(result.future.bookingId)}. They'll get a token when they arrive that day.
          </p>
        )}
        {(!todayWaitlisted || result.future) && <p className="mt-1">
          {result.notified
            ? 'Booking details sent to the patient by app notification (and WhatsApp where enabled).'
            : phoneDigits
              ? `No app account for +91${phoneDigits} yet - tell them their booking reference; the booking appears when they sign in with this number.`
              : ''}
        </p>}
        {phoneDigits && (
          <p className="mt-1 opacity-80">
            This patient can log in later with +91{phoneDigits} to see this visit and any history from other visits.
          </p>
        )}
        {/* Today's outcome above always succeeded by the time this screen shows
            - this is only ever the future-booking half failing (see the
            bookFuture branch in submit()), surfaced here since this screen
            replaces the form (and its own error line) entirely. */}
        {error && <p className="mt-2 text-red-700">{error}</p>}
        <button onClick={onCancel} className="mt-2 text-sm font-medium underline opacity-80">
          Close
        </button>
      </div>
    );
  }

  // Whether today can even take a walk-in for this doctor right now - drives
  // both the banner below and which outcome submit() attempts first.
  const slotFree = !availLoading && !!availability?.slotTime;

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-xl border border-slate-200 p-4">
      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Booking type">
        {([['walkin', 'Walk-in now'], ['booking', 'Book appointment']] as const).map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={mode === v}
            disabled={v === 'walkin' && !walkInAllowed}
            onClick={() => { setMode(v); setError(null); }}
            className={`rounded-2xl border px-3 py-2.5 text-sm font-semibold ${
              mode === v ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500'
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'booking' && (
        <p className="text-xs text-slate-500">
          For a patient who phones the clinic or asks for a later day: pick a free slot below. They are sent their
          booking details and arrive and check in like any other appointment.
        </p>
      )}
      <div>
        <label className="text-sm font-medium text-slate-700">Doctor</label>
        <select
          value={doctorId}
          onChange={(e) => setDoctorId(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        >
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · ₹{d.consultation_fee}
            </option>
          ))}
        </select>
      </div>

      {/* Availability, checked fresh for this doctor before anything else -
          see loadAvailability() above and schema.sql section 38. */}
      {mode === 'booking' ? null : availLoading ? (
        <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">Checking availability for this doctor...</p>
      ) : slotFree ? (
        <p className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-700">
          A slot is free — will be booked for <strong>{formatTimeLabel(availability!.slotTime!)}</strong> and checked
          in immediately.
        </p>
      ) : (
        <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
          <p className="font-semibold">
            {availability?.dayInfo?.isFull
              ? `Today is fully booked at this clinic (${availability.dayInfo.seatsTaken}/${availability.dayInfo.dailyCap}).`
              : availability?.hasWindows
                ? "No slot is free for this doctor right now."
                : "This doctor has no availability configured for today."}
          </p>
          <p className="mt-1">Registering below adds this patient to today's waitlist instead of the live queue.</p>
          {nextDay === undefined && (
            <button type="button" onClick={loadNextDay} className="mt-1.5 font-semibold underline">
              Check the next available day
            </button>
          )}
          {nextDay === 'loading' && <p className="mt-1.5">Checking...</p>}
          {nextDay === null && <p className="mt-1.5">No open slot found for this doctor in the next 7 days.</p>}
          {nextDay && nextDay !== 'loading' && (
            <p className="mt-1.5">
              Next open slot for this doctor:{' '}
              <strong>
                {new Date(nextDay + 'T00:00:00').toLocaleDateString(undefined, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })}
              </strong>
            </p>
          )}
        </div>
      )}

      {mode === 'walkin' && !availLoading && availability && availability.slots.length > 0 && (
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Today's slots</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {availability.slots.map((sl) => (
              <span
                key={sl.time}
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                  sl.time === availability.slotTime
                    ? 'bg-emerald-600 text-white'
                    : sl.free
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-slate-100 text-slate-400 line-through'
                }`}
              >
                {formatTimeLabel(sl.time)}
              </span>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-400">Green = free, struck through = booked or past. The darker one is where this patient will be seated.</p>
        </div>
      )}

      <div>
        <label className="text-sm font-medium text-slate-700">Patient name (as per Aadhaar)</label>
        <input
          type="text"
          required={!mrn.trim()}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name exactly as on Aadhaar"
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm font-medium text-slate-700">Mobile number{mrn.trim() ? ' (optional)' : ' *'}</label>
          <div className="mt-1 flex items-center rounded-2xl border border-slate-200 focus-within:ring-2 focus-within:ring-brand-500">
            <span className="pl-3 text-sm text-slate-500">+91</span>
            <input
              type="tel"
              inputMode="numeric"
              required={!mrn.trim()}
              maxLength={15}
              value={phoneDigits}
              onChange={(e) => setPhoneDigits(livePhoneDigits(e.target.value))}
              placeholder="9876543210"
              className="w-full rounded-lg px-2 py-2 text-sm outline-none"
            />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium text-slate-700">MRN (if known)</label>
          <input
            type="text"
            value={mrn}
            onChange={(e) => setMrn(e.target.value)}
            placeholder="MRN-00012456"
            className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Enter an MRN if the patient already has one — it identifies them exactly and skips the phone/name lookup
        below. Otherwise a matching phone number attaches this visit to their existing record; without either, a new
        patient is registered.
      </p>

      <div>
        <label className="text-sm font-medium text-slate-700">Government ID (optional)</label>
        <input
          type="text"
          value={govtId}
          onChange={(e) => setGovtId(e.target.value)}
          placeholder="Aadhaar, passport, etc."
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
        <p className="mt-1 text-xs text-slate-400">
          Helps recognise this patient if they've already been treated at another Sanjeevni clinic, so they keep one
          medical record number.
        </p>
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Reason for visit (optional)</label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Fever, follow-up, routine checkup"
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {mode === 'booking' && doctorId && (
        <div>
          <SlotPicker
            doctorId={doctorId}
            clinicId={clinicId}
            selectedDate={futureDate}
            selectedSlot={futureSlot}
            onSelect={(d, sl) => {
              setFutureDate(d);
              setFutureSlot(sl);
            }}
          />
          {futureDate && futureSlot && (
            <p className="mt-2 text-xs font-semibold text-emerald-700">
              Selected: {futureDate} at {formatTimeLabel(futureSlot)}
            </p>
          )}
        </div>
      )}

      {mode === 'walkin' && slotFree && (
        <div>
          <label className="text-sm font-medium text-slate-700">Collect payment now</label>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              onClick={() => setPaymentMethod('cod')}
              className={`flex-1 rounded-2xl border px-3 py-2.5 text-sm font-semibold ${
                paymentMethod === 'cod' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500'
              }`}
            >
              Cash{doctor ? ` — ₹${doctor.consultation_fee}` : ''}
            </button>
            <button
              type="button"
              onClick={() => setPaymentMethod('online')}
              className={`flex-1 rounded-2xl border px-3 py-2.5 text-sm font-semibold ${
                paymentMethod === 'online' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500'
              }`}
            >
              Online{doctor ? ` — ₹${doctor.consultation_fee}` : ''}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-slate-400">
            {paymentMethod === 'cod'
              ? 'Marked paid the moment they\'re registered - nothing left owing at the counter.'
              : 'Recorded exactly like a patient\'s own paid-online booking. Demo capture only - no real charge.'}
          </p>
        </div>
      )}

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-sm font-medium text-slate-700">Age (optional)</label>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={130}
            value={age}
            onChange={(e) => setAge(e.target.value)}
            className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="flex-1">
          <label className="text-sm font-medium text-slate-700">Gender (optional)</label>
          <select
            value={gender}
            onChange={(e) => setGender(e.target.value as Gender | '')}
            className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">—</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>

      {minor && (
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={guardianConsent}
            onChange={(e) => setGuardianConsent(e.target.checked)}
            className="mt-0.5"
          />
          This patient is under 18 - a parent/guardian is present and consents to this visit.
        </label>
      )}

      {mode === 'walkin' && <p className="text-xs text-slate-400">
        {slotFree
          ? 'Added directly to today\'s queue and checked in immediately.'
          : "No slot is free right now - added to today's waitlist instead. Payment is collected only once a slot opens up and they're actually seen."}
      </p>}

      {mode === 'walkin' && <div className="rounded-lg border border-slate-200 p-3">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" checked={bookFuture} onChange={(e) => setBookFuture(e.target.checked)} />
          Also book a future appointment for this patient
        </label>
        {bookFuture && doctorId && (
          <div className="mt-3">
            <SlotPicker
              doctorId={doctorId}
              clinicId={clinicId}
              selectedDate={futureDate}
              selectedSlot={futureSlot}
              onSelect={(d, s) => {
                setFutureDate(d);
                setFutureSlot(s);
              }}
            />
          </div>
        )}
      </div>}

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || (mode === 'walkin' && availLoading)}
          className="rounded-2xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {saving ? 'Adding...' : mode === 'booking' ? 'Book appointment' : slotFree ? 'Add to queue' : 'Add to waitlist'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-slate-500">
          Cancel
        </button>
      </div>
    </form>
  );
}
