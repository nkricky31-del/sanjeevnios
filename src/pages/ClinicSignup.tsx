import { useRef, useState, type FormEvent } from 'react';

import { useAuth } from '../lib/AuthContext';
import { VERIFICATION_DOCS_BUCKET } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import InfoBanner from '../components/ui/InfoBanner';

interface Props {
  onRegistered?: () => void;
}

const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10MB - matches the bucket's server-side limit
const ALLOWED_DOC_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

// The clinic registration form itself - embedded both by App.tsx (right
// after a "Register your clinic" login) and by ClinicQueue.tsx (defensive
// fallback for a 'clinic'-role account that somehow has no clinic row yet).
// Neither host wants a second page header, so this renders bare, no chrome.
export default function ClinicSignup({ onRegistered }: Props) {
  const { refreshProfile } = useAuth();
  const [name, setName] = useState('');
  const [regNo, setRegNo] = useState('');
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Enter your clinic name.');
      return;
    }
    if (!regNo.trim()) {
      setError('Enter your clinic registration number.');
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
    const { data: newClinic, error: rpcError } = await supabase.rpc('register_clinic', {
      p_name: name.trim(),
      p_reg_no: regNo.trim(),
      p_address: address.trim() || null,
    });

    if (rpcError || !newClinic) {
      setLoading(false);
      setError(rpcError?.message ?? 'Could not register the clinic.');
      return;
    }

    // The document can only be uploaded to a path scoped by clinic id, which
    // doesn't exist until the clinic row above does - so this is a
    // necessary second step, not something that can be combined into one.
    // A failed upload shouldn't block registration itself (the clinic row
    // already exists) - but it must be SHOWN, not swallowed, or the clinic
    // owner has no way to know their document never actually attached.
    if (file) {
      const path = `clinics/${newClinic.id}/${crypto.randomUUID()}-${file.name}`;
      const { error: uploadError } = await supabase.storage.from(VERIFICATION_DOCS_BUCKET).upload(path, file, {
        contentType: file.type,
      });
      if (uploadError) {
        setLoading(false);
        setUploadWarning(`Clinic registered, but the document didn't upload: ${uploadError.message}`);
        return;
      }
      await supabase.from('clinics').update({ registration_doc_path: path }).eq('id', newClinic.id);
    }

    setLoading(false);

    // Flips profile.role to 'clinic' in local state - App.tsx will then
    // render the clinic dashboard on the next render, no navigation needed.
    await refreshProfile();
    onRegistered?.();
  };

  const continueWithoutDoc = async () => {
    await refreshProfile();
    onRegistered?.();
  };

  if (uploadWarning) {
    return (
      <Card>
        <p className="text-sm font-semibold text-amber-800">{uploadWarning}</p>
        <p className="mt-2 text-sm text-slate-600">
          You can continue - the admin can ask for the document separately during review.
        </p>
        <Button onClick={continueWithoutDoc} className="mt-3" full>
          Continue to clinic dashboard
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-4 text-lg font-bold text-slate-900">Register your clinic</h1>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="text-sm font-medium text-slate-700">Clinic name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sunrise Family Clinic"
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-slate-700">Registration number</label>
          <input
            type="text"
            value={regNo}
            onChange={(e) => setRegNo(e.target.value)}
            placeholder="e.g. KA-CLINIC-2026-1234"
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-slate-700">Address</label>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street, area, city"
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-slate-700">Registration document (optional)</label>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            className="mt-1 w-full text-sm"
          />
          <p className="mt-1 text-xs text-slate-400">JPG, PNG, or PDF, up to 10MB - speeds up admin approval.</p>
        </div>

        <InfoBanner>
          Your clinic will be created with "pending" status. It stays hidden from patient search - and can't accept
          bookings - until an admin approves it. You can still add doctors and set their availability while waiting.
        </InfoBanner>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <Button type="submit" disabled={loading} full>
          {loading ? 'Registering...' : 'Register clinic'}
        </Button>
      </form>
    </Card>
  );
}
