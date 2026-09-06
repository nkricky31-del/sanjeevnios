import { CheckCircle2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';

import { useAuth } from '../lib/AuthContext';
import { uploadVerificationDocument } from '../lib/documents';
import { supabase } from '../lib/supabaseClient';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import InfoBanner from '../components/ui/InfoBanner';

interface Props {
  onRegistered?: () => void;
}

interface QuickStartClinic {
  id: string;
  name: string;
}

// The clinic's QUICK-START registration (schema.sql section 48). Phone+OTP
// has already happened by the time this renders - the same login screen
// every patient uses (Login.tsx) - so this is deliberately the lightest
// possible FIRST step: name, registration number, one certificate. Submitting
// creates the clinic at status='draft' (register_clinic_quick_start()) - the
// confirmation screen below tells the clinic what's still needed before it
// can actually be sent for review.
//
// Section 55 tightened this: a clinic can no longer reach the admin's queue
// with zero doctors, so quick-start can no longer skip straight to
// 'pending' either - map location, the two remaining verification documents
// (clinic_address_proof, clinic_license), and at least one fully-onboarded
// doctor all still have to be added from the dashboard's Doctors tab
// (ClinicDoctors.tsx / ClinicOnboardingScreen.tsx) before its own "Send for
// verification" button - which only appears for a 'draft' clinic - will
// even enable, let alone succeed server-side.
//
// Embedded bare (no page header) by both App.tsx (right after a "Register
// your clinic" login) and ClinicQueue.tsx (defensive fallback for a
// 'clinic'-role account that somehow has no clinic row yet).
export default function ClinicSignup({ onRegistered }: Props) {
  const { refreshProfile } = useAuth();
  const [name, setName] = useState('');
  const [regNo, setRegNo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Set once the clinic itself is registered - swaps the form for the
  // "under verification" confirmation. refreshProfile() (which flips
  // profile.role to 'clinic' and, per App.tsx's render order, replaces this
  // screen with the dashboard on the very next render) is deliberately
  // deferred until the clinic dismisses THAT screen, not fired the moment
  // registration succeeds - otherwise this confirmation would never be seen.
  const [registered, setRegistered] = useState<QuickStartClinic | null>(null);

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
    if (!file) {
      setError('Upload your clinic registration certificate.');
      return;
    }

    setLoading(true);
    const { data, error: rpcError } = await supabase.rpc('register_clinic_quick_start', {
      p_name: name.trim(),
      p_reg_no: regNo.trim(),
    });
    const clinic = data as QuickStartClinic | null;
    if (rpcError || !clinic) {
      setLoading(false);
      setError(rpcError?.message ?? 'Could not register the clinic.');
      return;
    }

    const upload = await uploadVerificationDocument({
      ownerType: 'clinic',
      ownerId: clinic.id,
      docType: 'clinic_registration_certificate',
      file,
    });
    setLoading(false);
    if (upload.error) {
      // The clinic itself is already registered at this point - re-uploading
      // the certificate from the Doctors tab afterwards is a normal recovery
      // path (DocumentChecklist.tsx), so this isn't a dead end.
      setError(`Clinic registered, but the certificate upload failed: ${upload.error}. You can upload it again from the Doctors tab once inside.`);
    }
    setRegistered(clinic);
  };

  const finish = async () => {
    await refreshProfile();
    onRegistered?.();
  };

  if (registered) {
    return (
      <Card className="text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
          <CheckCircle2 size={28} />
        </div>
        <h1 className="mt-3 text-lg font-bold text-slate-900">Almost there</h1>
        <p className="mt-1 text-sm text-slate-500">
          <strong>{registered.name}</strong> is registered as a draft. Finish setup from the Doctors tab before it can
          be sent for review.
        </p>
        <div className="mt-4 text-left">
          <InfoBanner>
            Still needed: your exact map location, the rest of your verification documents, and at least one doctor
            with all of their required documents submitted. {registered.name} stays hidden from patient search and
            can't accept bookings until an admin approves it.
          </InfoBanner>
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <Button className="mt-4" full onClick={finish}>
          Continue to dashboard
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
            className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-slate-700">Registration number</label>
          <input
            type="text"
            value={regNo}
            onChange={(e) => setRegNo(e.target.value)}
            placeholder="e.g. KA-CLINIC-2026-1234"
            className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-slate-700">Clinic registration certificate</label>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            className="mt-1 block w-full text-sm"
          />
          <p className="mt-1 text-xs text-slate-400">JPG, PNG, or PDF, up to 10MB.</p>
        </div>

        <InfoBanner>
          This registers your clinic as a draft. You'll still need to add your exact map location, at least one
          doctor with their required documents, and the rest of your verification documents from the dashboard before
          it can be sent for review. It stays hidden from patient search — and can't accept bookings — until an admin
          approves it.
        </InfoBanner>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <Button type="submit" disabled={loading} full>
          {loading ? 'Registering...' : 'Register clinic'}
        </Button>
      </form>
    </Card>
  );
}
