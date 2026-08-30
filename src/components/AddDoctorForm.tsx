import { useRef, useState, type FormEvent } from 'react';

import { VERIFICATION_DOCS_BUCKET } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';

interface Props {
  clinicId: string;
  onAdded: () => void;
  onCancel: () => void;
}

const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10MB - matches the bucket's server-side limit
const ALLOWED_DOC_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

export default function AddDoctorForm({ clinicId, onAdded, onCancel }: Props) {
  const [name, setName] = useState('');
  const [regNo, setRegNo] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [fee, setFee] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    const file = fileRef.current?.files?.[0] ?? null;
    if (file) {
      if (!ALLOWED_DOC_TYPES.includes(file.type)) {
        setError('Document must be a JPG, PNG, or PDF.');
        return;
      }
      if (file.size > MAX_DOC_BYTES) {
        setError('Document must be under 10MB.');
        return;
      }
    }

    setLoading(true);
    // status defaults to 'pending' in the DB - a new doctor is invisible to
    // patient search until an admin approves them individually, even though
    // their clinic may already be approved.
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

    if (insertError || !newDoctor) {
      setLoading(false);
      setError(insertError?.message ?? 'Could not add the doctor.');
      return;
    }

    // Same reasoning as ClinicSignup.tsx: the document's path is scoped by
    // doctor id, which doesn't exist until the row above does. A failed
    // upload shouldn't block adding the doctor (that already succeeded),
    // but it must be shown, not swallowed - otherwise there's no way to know
    // the document never actually attached.
    if (file) {
      const path = `doctors/${newDoctor.id}/${crypto.randomUUID()}-${file.name}`;
      const { error: uploadError } = await supabase.storage.from(VERIFICATION_DOCS_BUCKET).upload(path, file, {
        contentType: file.type,
      });
      if (uploadError) {
        setLoading(false);
        setUploadWarning(`Doctor added, but the document didn't upload: ${uploadError.message}`);
        return;
      }
      await supabase.from('doctors').update({ registration_doc_path: path }).eq('id', newDoctor.id);
    }

    setLoading(false);
    onAdded();
  };

  if (uploadWarning) {
    return (
      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <p className="font-semibold">{uploadWarning}</p>
        <p className="mt-1">You can continue - the admin can ask for the document separately during review.</p>
        <button
          onClick={onAdded}
          className="mt-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white"
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-xl border border-slate-200 p-4">
      <div>
        <label className="text-sm font-medium text-slate-700">Doctor name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Dr. Asha Rao"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Registration number</label>
        <input
          type="text"
          value={regNo}
          onChange={(e) => setRegNo(e.target.value)}
          placeholder="e.g. MCI-12345"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Specialty</label>
        <input
          type="text"
          value={specialty}
          onChange={(e) => setSpecialty(e.target.value)}
          placeholder="e.g. General Physician"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
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
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div>
        <label className="text-sm font-medium text-slate-700">Registration document (optional)</label>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,application/pdf" className="mt-1 w-full text-sm" />
        <p className="mt-1 text-xs text-slate-400">JPG, PNG, or PDF, up to 10MB - speeds up admin approval.</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? 'Saving...' : 'Add doctor'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-slate-500">
          Cancel
        </button>
      </div>
    </form>
  );
}
