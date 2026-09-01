import { useState, type FormEvent } from 'react';

import { isMinorDob } from '../lib/date';
import { livePhoneDigits, normalizePhone } from '../lib/phone';
import { supabase } from '../lib/supabaseClient';
import type { FamilyRelation } from '../lib/types';

interface Props {
  accountId: string;
  onAdded: () => void;
  onCancel: () => void;
}

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

export default function FamilyMemberForm({ accountId, onAdded, onCancel }: Props) {
  const [name, setName] = useState('');
  const [relation, setRelation] = useState<FamilyRelation>('self');
  const [dob, setDob] = useState('');
  const [phoneDigits, setPhoneDigits] = useState('');
  const [email, setEmail] = useState('');
  const [bloodGroup, setBloodGroup] = useState('');
  const [city, setCity] = useState('');
  const [govtId, setGovtId] = useState('');
  const [guardianConsent, setGuardianConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const minor = dob ? isMinorDob(dob) : false;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Enter a name.');
      return;
    }
    if (!dob) {
      setError('Enter a date of birth.');
      return;
    }
    if (new Date(dob) > new Date()) {
      setError('Date of birth cannot be in the future.');
      return;
    }
    if (phoneDigits && phoneDigits.length !== 10) {
      setError('Phone number must be 10 digits.');
      return;
    }
    if (minor && !guardianConsent) {
      setError('Guardian consent is required for family members under 18.');
      return;
    }

    setLoading(true);
    const { error: insertError } = await supabase.from('family_members').insert({
      account_id: accountId,
      name: name.trim(),
      relation,
      dob,
      phone: phoneDigits ? normalizePhone(phoneDigits) : null,
      email: email.trim() || null,
      blood_group: bloodGroup || null,
      city: city.trim() || null,
      govt_id: govtId.trim() || null,
      guardian_consent: guardianConsent,
    });
    setLoading(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }
    onAdded();
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 rounded-xl border border-slate-200 p-4">
      <div>
        <label className="text-sm font-medium text-slate-700">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Relation</label>
        <select
          value={relation}
          onChange={(e) => setRelation(e.target.value as FamilyRelation)}
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="self">Self</option>
          <option value="spouse">Spouse</option>
          <option value="child">Child</option>
          <option value="parent">Parent</option>
        </select>
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Date of birth</label>
        <input
          type="date"
          value={dob}
          onChange={(e) => setDob(e.target.value)}
          max={new Date().toISOString().slice(0, 10)}
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Phone (optional)</label>
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
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-sm font-medium text-slate-700">Email (optional)</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="flex-1">
          <label className="text-sm font-medium text-slate-700">Blood group (optional)</label>
          <select
            value={bloodGroup}
            onChange={(e) => setBloodGroup(e.target.value)}
            className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">—</option>
            {BLOOD_GROUPS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">City (optional)</label>
        <input
          type="text"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Government ID (optional)</label>
        <input
          type="text"
          value={govtId}
          onChange={(e) => setGovtId(e.target.value)}
          placeholder="Aadhaar, passport, etc."
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-brand-500"
        />
        <p className="mt-1 text-xs text-slate-400">
          Helps us recognise this person if they've already been treated at another Sanjeevni clinic, so they keep one
          medical record number.
        </p>
      </div>

      {minor && (
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={guardianConsent}
            onChange={(e) => setGuardianConsent(e.target.checked)}
            className="mt-0.5"
          />
          I am this person's parent/guardian and consent to booking on their behalf.
        </label>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="rounded-2xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm shadow-brand-600/25 disabled:opacity-50"
        >
          {loading ? 'Saving...' : 'Save member'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-slate-500">
          Cancel
        </button>
      </div>
    </form>
  );
}
