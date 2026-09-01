import { useState, type FormEvent } from 'react';

import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabaseClient';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import InfoBanner from '../components/ui/InfoBanner';

interface Props {
  onRegistered?: () => void;
}

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

    setLoading(true);
    const { error: rpcError } = await supabase.rpc('register_clinic', {
      p_name: name.trim(),
      p_reg_no: regNo.trim(),
      p_address: address.trim() || null,
    });
    setLoading(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    // Flips profile.role to 'clinic' in local state - App.tsx will then
    // render the clinic dashboard on the next render, no navigation needed.
    // The clinic's own document checklist (e.g. clinic registration
    // certificate) is filled in from the clinic dashboard afterward, via
    // the same DocumentChecklist used for doctor onboarding.
    await refreshProfile();
    onRegistered?.();
  };

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
          <label className="text-sm font-medium text-slate-700">Address</label>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street, area, city"
            className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <InfoBanner>
          Your clinic will be created with "pending" status. It stays hidden from patient search - and can't accept
          bookings - until an admin approves it. You'll upload your clinic registration document and add doctors
          from the clinic dashboard next.
        </InfoBanner>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <Button type="submit" disabled={loading} full>
          {loading ? 'Registering...' : 'Register clinic'}
        </Button>
      </form>
    </Card>
  );
}
