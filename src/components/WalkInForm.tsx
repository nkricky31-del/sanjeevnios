import { useState, type FormEvent } from 'react';

import { useAuth } from '../lib/AuthContext';
import { dobFromAge, isMinorDob, todayISO } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import type { Gender } from '../lib/types';

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

export default function WalkInForm({ clinicId, doctors, defaultDoctorId, onAdded, onCancel }: Props) {
  const { session } = useAuth();
  const [doctorId, setDoctorId] = useState(defaultDoctorId);
  const [name, setName] = useState('');
  const [phoneDigits, setPhoneDigits] = useState('');
  const [govtId, setGovtId] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<Gender | ''>('');
  const [guardianConsent, setGuardianConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedToken, setAddedToken] = useState<number | null>(null);
  const [addedMrn, setAddedMrn] = useState<string | null>(null);

  const ageNum = age ? Number(age) : null;
  const dob = ageNum != null && ageNum >= 0 ? dobFromAge(ageNum) : null;
  const minor = dob ? isMinorDob(dob) : false;

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
    if (phoneDigits && phoneDigits.length !== 10) {
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

    setSaving(true);

    // A walk-in has no patient account of their own yet. Modeled as a
    // "family member" owned by the CLINIC's own account, relation 'self'
    // since it's the walk-in patient themselves - purely so the booking has
    // someone to attach to, same as every other appointment in this app.
    // Storing the phone in the SAME format Login.tsx sends to Supabase Auth
    // ('91' + 10 digits, no '+') is what lets claim_walk_in_records() match
    // it exactly once this person eventually signs in for real.
    const { data: member, error: memberError } = await supabase
      .from('family_members')
      .insert({
        account_id: session.user.id,
        name: name.trim(),
        relation: 'self',
        phone: phoneDigits ? `91${phoneDigits}` : null,
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

    const nowTime = new Date().toTimeString().slice(0, 8); // "HH:MM:SS", local time
    const { data: appointment, error: apptError } = await supabase
      .from('appointments')
      .insert({
        member_id: member.id,
        doctor_id: doctorId,
        clinic_id: clinicId,
        date: todayISO(),
        slot_time: nowTime,
        status: 'pending',
        payment_status: 'cod',
      })
      .select('id')
      .single();
    if (apptError || !appointment) {
      setSaving(false);
      setError(apptError?.message ?? 'Could not add to the queue.');
      return;
    }

    // Reuse the exact same accept transition the inbox uses - it's what
    // assigns the next token number. payment_status stays 'cod', i.e. due
    // at the desk.
    const { data: accepted, error: acceptError } = await supabase
      .from('appointments')
      .update({ status: 'accepted' })
      .eq('id', appointment.id)
      .select('token_no')
      .single();
    if (acceptError || !accepted) {
      setSaving(false);
      setError(acceptError?.message ?? 'Could not add to the queue.');
      return;
    }

    const doctor = doctors.find((d) => d.id === doctorId);
    await supabase.from('payments').insert({
      appointment_id: appointment.id,
      amount: doctor?.consultation_fee ?? 0,
      method: 'cod',
      status: 'pending',
    });

    setSaving(false);
    setAddedToken(accepted.token_no);
    setAddedMrn((member as { mrn: string }).mrn);
    onAdded();
  };

  if (addedToken != null) {
    const doctorName = doctors.find((d) => d.id === doctorId)?.name ?? 'the doctor';
    return (
      <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
        <p className="font-semibold">Added to today's queue for {doctorName}.</p>
        <p className="mt-1">Token number: #{addedToken}</p>
        {addedMrn && <p className="mt-1 font-mono text-xs text-emerald-700">Medical record number: {addedMrn}</p>}
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
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Doctor</label>
        <select
          value={doctorId}
          onChange={(e) => setDoctorId(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
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
        <div className="mt-1 flex items-center rounded-lg border border-slate-300 focus-within:ring-2 focus-within:ring-brand-500">
          <span className="pl-3 text-sm text-slate-500">+91</span>
          <input
            type="tel"
            inputMode="numeric"
            maxLength={10}
            value={phoneDigits}
            onChange={(e) => setPhoneDigits(e.target.value.replace(/\D/g, ''))}
            placeholder="9876543210"
            className="w-full rounded-lg px-2 py-2 text-sm outline-none"
          />
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Lets this patient log in later and see this visit and any future ones together.
        </p>
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Government ID (optional)</label>
        <input
          type="text"
          value={govtId}
          onChange={(e) => setGovtId(e.target.value)}
          placeholder="Aadhaar, passport, etc."
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
        <p className="mt-1 text-xs text-slate-400">
          Helps recognise this patient if they've already been treated at another Sanjeevni clinic, so they keep one
          medical record number.
        </p>
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
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="flex-1">
          <label className="text-sm font-medium text-slate-700">Gender (optional)</label>
          <select
            value={gender}
            onChange={(e) => setGender(e.target.value as Gender | '')}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
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
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
