import { useState, type FormEvent } from 'react';

import { supabase } from '../lib/supabaseClient';

interface Props {
  clinicId: string;
  onAdded: (doctorId: string) => void;
  onCancel: () => void;
}

export default function AddDoctorForm({ clinicId, onAdded, onCancel }: Props) {
  const [name, setName] = useState('');
  const [regNo, setRegNo] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [fee, setFee] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Enter the doctor name.');
      return;
    }
    if (!regNo.trim()) {
      setError('Enter the doctor registration number.');
      return;
    }
    const feeNum = Number(fee);
    if (fee !== '' && (Number.isNaN(feeNum) || feeNum < 0)) {
      setError('Consultation fee must be a positive number.');
      return;
    }

    setLoading(true);
    // status defaults to 'draft' in the DB - the clinic still needs to sign
    // the onboarding agreement and upload the required documents (next
    // screen) before this doctor can be submitted for admin review.
    const { data: newDoctor, error: insertError } = await supabase
      .from('doctors')
      .insert({
        clinic_id: clinicId,
        name: name.trim(),
        reg_no: regNo.trim(),
        specialty: specialty.trim() || null,
        consultation_fee: feeNum || 0,
      })
      .select('id')
      .single();

    setLoading(false);
    if (insertError || !newDoctor) {
      setError(insertError?.message ?? 'Could not add the doctor.');
      return;
    }
    onAdded(newDoctor.id);
  };

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-xl border border-slate-200 p-4">
      <div>
        <label className="text-sm font-medium text-slate-700">Doctor name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Dr. Asha Rao"
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Registration number</label>
        <input
          type="text"
          value={regNo}
          onChange={(e) => setRegNo(e.target.value)}
          placeholder="e.g. MCI-12345"
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Specialty</label>
        <input
          type="text"
          value={specialty}
          onChange={(e) => setSpecialty(e.target.value)}
          placeholder="e.g. General Physician"
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Consultation fee (₹)</label>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={fee}
          onChange={(e) => setFee(e.target.value)}
          placeholder="e.g. 300"
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <p className="text-xs text-slate-400">
        You'll sign the onboarding agreement and upload the required documents on the next screen.
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="rounded-2xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm shadow-brand-600/25 disabled:opacity-50"
        >
          {loading ? 'Saving...' : 'Add doctor & continue'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-slate-500">
          Cancel
        </button>
      </div>
    </form>
  );
}
