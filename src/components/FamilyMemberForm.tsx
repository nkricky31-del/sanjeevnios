import { useState, type FormEvent } from 'react';

import { isMinorDob } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import type { FamilyRelation } from '../lib/types';

interface Props {
  accountId: string;
  onAdded: () => void;
  onCancel: () => void;
}

export default function FamilyMemberForm({ accountId, onAdded, onCancel }: Props) {
  const [name, setName] = useState('');
  const [relation, setRelation] = useState<FamilyRelation>('self');
  const [dob, setDob] = useState('');
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
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Relation</label>
        <select
          value={relation}
          onChange={(e) => setRelation(e.target.value as FamilyRelation)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500"
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
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500"
        />
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
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
