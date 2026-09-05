import { useState, type FormEvent } from 'react';

import { useAuth } from '../lib/AuthContext';
import { livePhoneDigits, normalizePhone } from '../lib/phone';
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
//
// Section 45: this only collects the clinic's basic details + contact - the
// clinic is created as 'draft', and the actual verification uploads (plus
// map location) happen next, from the clinic dashboard's Doctors tab
// (ClinicOnboardingScreen.tsx) - the clinic only reaches the admin's queue
// once it explicitly submits from there.
export default function ClinicSignup({ onRegistered }: Props) {
  const { refreshProfile } = useAuth();
  const [name, setName] = useState('');
  const [regNo, setRegNo] = useState('');
  const [address, setAddress] = useState('');
  const [contactPhoneDigits, setContactPhoneDigits] = useState('');
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
    if (!address.trim()) {
      setError('Enter your clinic address.');
      return;
    }
    if (contactPhoneDigits.length !== 10) {
      setError('Enter a valid 10-digit contact phone number.');
      return;
    }

    setLoading(true);
    const { error: rpcError } = await supabase.rpc('register_clinic', {
      p_name: name.trim(),
      p_reg_no: regNo.trim(),
      p_address: address.trim() || null,
      p_contact_phone: normalizePhone(contactPhoneDigits),
    });
    setLoading(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    // Flips profile.role to 'clinic' in local state - App.tsx will then
    // render the clinic dashboard on the next render, no navigation needed.
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

        <div>
          <label className="text-sm font-medium text-slate-700">Contact phone</label>
          <div className="mt-1 flex items-center rounded-2xl border border-slate-200 focus-within:ring-2 focus-within:ring-brand-500">
            <span className="pl-3 text-sm text-slate-500">+91</span>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={10}
              value={contactPhoneDigits}
              onChange={(e) => setContactPhoneDigits(livePhoneDigits(e.target.value))}
              placeholder="9876543210"
              className="w-full rounded-lg px-2 py-2 text-sm outline-none"
            />
          </div>
          <p className="mt-1 text-xs text-slate-400">The desk number patients and Sanjeevni admins can reach you on.</p>
        </div>

        <InfoBanner>
          Your clinic will be created as a draft. Next, you'll place your exact location on the map, upload your
          verification documents, and add your doctors - your clinic only joins the admin review queue once you
          submit it from the dashboard. It stays hidden from patient search - and can't accept bookings - until
          then and until an admin approves it.
        </InfoBanner>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <Button type="submit" disabled={loading} full>
          {loading ? 'Registering...' : 'Register clinic'}
        </Button>
      </form>
    </Card>
  );
}
