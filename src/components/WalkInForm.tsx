import { useState, type FormEvent } from 'react';

import { useAuth } from '../lib/AuthContext';
import { dobFromAge, isMinorDob, todayISO } from '../lib/date';
import { livePhoneDigits, normalizePhone } from '../lib/phone';
import { bookingReference } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import type { Gender, PatientType } from '../lib/types';
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
  onAdded: () => void;
  onCancel: () => void;
}

interface BookingOutcome {
  bookingId: string;
  position: number;
}

interface AddedResult {
  today: BookingOutcome;
  mrn: string;
  matchedExisting: boolean;
  future: (BookingOutcome & { date: string; slotTime: string }) | null;
}

// Runs the same "insert pending -> accept -> record payment" sequence used
// for both today's walk-in visit and an optional future booking made in the
// same flow, with every step's error actually checked and surfaced (see the
// try/catch in submit() below for the other half of that - a thrown/rejected
// promise, e.g. from a network or Supabase URL misconfiguration, used to
// leave the form stuck on "Adding..." with no error shown at all).
//
// token_no here is a recomputed queue POSITION (see
// recompute_queue_positions() in schema.sql section 26), not a permanent
// ticket - it can shift if a checked-in patient's grace period lapses or a
// walk-in is inserted ahead of them. The appointment's own id is what's
// stable, so that's what gets shown to the patient as their booking
// reference (see bookingReference() in lib/queue.ts), with the position
// shown alongside as a live "where you are right now" indicator.
async function createAndAcceptAppointment(params: {
  memberId: string;
  doctorId: string;
  clinicId: string;
  date: string;
  slotTime: string;
  reason: string | null;
  consultationFee: number;
  patientType: PatientType;
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
      status: 'pending',
      payment_status: 'cod',
      patient_type: params.patientType,
    })
    .select('id')
    .single();
  if (apptError || !appointment) {
    return { error: apptError?.message ?? 'Could not add to the queue.' };
  }

  // Reuse the exact same accept transition the inbox uses - a walk-in gets
  // checked_in_at stamped automatically here (see
  // handle_appointment_status_change() in schema.sql). The resulting queue
  // position is computed by a SEPARATE AFTER trigger (recompute_queue_positions)
  // that runs its own nested UPDATE - Postgres's RETURNING only reflects
  // the row as of THIS statement, not a later trigger-driven one, so the
  // position has to be re-read with a fresh select rather than trusted off
  // this update's own .select().
  const { error: acceptError } = await supabase.from('appointments').update({ status: 'accepted' }).eq('id', appointment.id);
  if (acceptError) {
    return { error: acceptError.message };
  }
  const { data: accepted, error: readError } = await supabase
    .from('appointments')
    .select('token_no')
    .eq('id', appointment.id)
    .single();
  if (readError || !accepted || accepted.token_no == null) {
    return { error: readError?.message ?? 'Could not add to the queue.' };
  }

  const { error: paymentError } = await supabase.from('payments').insert({
    appointment_id: appointment.id,
    amount: params.consultationFee,
    method: 'cod',
    status: 'pending',
  });
  if (paymentError) {
    // The appointment itself is already booked and has a position - a
    // missing payment row is a billing-desk problem, not a reason to tell
    // the front desk the booking failed (it didn't). Surfaced as a warning
    // below rather than swallowed outright.
    return {
      error: `Booked (queue position #${accepted.token_no}, ref ${bookingReference(appointment.id)}), but the payment record failed to save: ${paymentError.message}`,
    };
  }

  return { bookingId: appointment.id, position: accepted.token_no };
}

export default function WalkInForm({ clinicId, doctors, defaultDoctorId, onAdded, onCancel }: Props) {
  const { session } = useAuth();
  const [doctorId, setDoctorId] = useState(defaultDoctorId);
  const [name, setName] = useState('');
  const [phoneDigits, setPhoneDigits] = useState('');
  const [govtId, setGovtId] = useState('');
  const [reason, setReason] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<Gender | ''>('');
  const [guardianConsent, setGuardianConsent] = useState(false);
  const [bookFuture, setBookFuture] = useState(false);
  const [futureDate, setFutureDate] = useState<string | null>(null);
  const [futureSlot, setFutureSlot] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AddedResult | null>(null);

  const ageNum = age ? Number(age) : null;
  const dob = ageNum != null && ageNum >= 0 ? dobFromAge(ageNum) : null;
  const minor = dob ? isMinorDob(dob) : false;
  const doctor = doctors.find((d) => d.id === doctorId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!session) return;

    if (!name.trim()) {
      setError('Enter the patient name.');
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
    if (bookFuture && (!futureDate || !futureSlot)) {
      setError('Pick a date and time for the future appointment, or uncheck "Also book a future appointment".');
      return;
    }

    setSaving(true);
    try {
      const normalizedPhone = phoneDigits ? normalizePhone(phoneDigits) : null;
      let memberId = '';
      let mrn = '';
      let matchedExisting = false;

      // If this phone number already belongs to a patient (their own
      // account, or a walk-in stub from any clinic), attach this visit to
      // THAT record instead of creating a duplicate one - see
      // find_family_member_by_phone() in migration_25_walkin_fixes.sql for
      // why this has to be a security-definer RPC rather than a plain
      // select (plain RLS can't see this row until an appointment already
      // links it to this clinic, which is exactly what we're about to create).
      if (normalizedPhone) {
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
          mrn = match.mrn;
          matchedExisting = true;
        }
      }

      if (!matchedExisting) {
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
        mrn = member.mrn;
      }

      const nowTime = new Date().toTimeString().slice(0, 8); // "HH:MM:SS", local time
      const todayResult = await createAndAcceptAppointment({
        memberId,
        doctorId,
        clinicId,
        date: todayISO(),
        slotTime: nowTime,
        reason: reason.trim() || null,
        consultationFee: doctor?.consultation_fee ?? 0,
        patientType: 'walk_in',
      });
      if ('error' in todayResult) {
        setSaving(false);
        setError(todayResult.error);
        return;
      }

      let future: AddedResult['future'] = null;
      if (bookFuture && futureDate && futureSlot) {
        // 'scheduled', not 'walk_in': this is a genuine future slot, not
        // someone standing at the desk right now - it holds its slot-time
        // position and is subject to the same grace-period/check-in rule
        // as any other advance booking once that day arrives.
        const futureResult = await createAndAcceptAppointment({
          memberId,
          doctorId,
          clinicId,
          date: futureDate,
          slotTime: futureSlot,
          reason: reason.trim() || null,
          consultationFee: doctor?.consultation_fee ?? 0,
          patientType: 'scheduled',
        });
        if ('error' in futureResult) {
          // Today's visit is already booked at this point - don't lose that
          // success, just report the future booking failed.
          setError(`Today's visit was added, but the future appointment could not be booked: ${futureResult.error}`);
          setSaving(false);
          setResult({ today: todayResult, mrn, matchedExisting, future: null });
          return;
        }
        future = { ...futureResult, date: futureDate, slotTime: futureSlot };
      }

      setSaving(false);
      setResult({ today: todayResult, mrn, matchedExisting, future });
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
    return (
      <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
        <p className="font-semibold">Added to today's queue for {doctorName}.</p>
        <p className="mt-1">
          Booking reference: <span className="font-mono font-semibold">{bookingReference(result.today.bookingId)}</span>
        </p>
        <p className="mt-0.5">
          Current queue position: #{result.today.position}
          <span className="text-xs text-emerald-700"> (this can shift if a scheduled patient's grace period lapses or another walk-in arrives - the reference above stays the same)</span>
        </p>
        <p className="mt-1 font-mono text-xs text-emerald-700">Medical record number: {result.mrn}</p>
        {result.matchedExisting && (
          <p className="mt-1 text-emerald-700">Matched to an existing patient record - no duplicate created.</p>
        )}
        {result.future && (
          <p className="mt-1">
            Future appointment booked for {result.future.date} at {formatTimeLabel(result.future.slotTime)} — ref{' '}
            {bookingReference(result.future.bookingId)}, position #{result.future.position}.
          </p>
        )}
        {phoneDigits && (
          <p className="mt-1 text-emerald-700">
            This patient can log in later with +91{phoneDigits} to see this visit and any history from other visits.
          </p>
        )}
        <button onClick={onCancel} className="mt-2 text-sm font-medium text-emerald-700 underline">
          Close
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-xl border border-slate-200 p-4">
      <div>
        <label className="text-sm font-medium text-slate-700">Patient name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Walk-in patient's name"
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

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

      <div>
        <label className="text-sm font-medium text-slate-700">Mobile number (optional)</label>
        <div className="mt-1 flex items-center rounded-2xl border border-slate-200 focus-within:ring-2 focus-within:ring-brand-500">
          <span className="pl-3 text-sm text-slate-500">+91</span>
          <input
            type="tel"
            inputMode="numeric"
            maxLength={15}
            value={phoneDigits}
            onChange={(e) => setPhoneDigits(livePhoneDigits(e.target.value))}
            placeholder="9876543210"
            className="w-full rounded-lg px-2 py-2 text-sm outline-none"
          />
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Lets this patient log in later and see this visit and any future ones together. If this number already
          belongs to a patient, this visit is attached to their existing record instead of creating a new one.
        </p>
      </div>

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

      <p className="text-xs text-slate-400">Added directly to today's queue, marked cash-on-visit (due at the desk).</p>

      <div className="rounded-lg border border-slate-200 p-3">
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
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-2xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm shadow-brand-600/25 disabled:opacity-50"
        >
          {saving ? 'Adding...' : 'Add to queue'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-slate-500">
          Cancel
        </button>
      </div>
    </form>
  );
}
