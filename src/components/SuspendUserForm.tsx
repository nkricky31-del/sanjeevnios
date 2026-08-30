import { useState } from 'react';

import { recordAdminDecision } from '../lib/audit';
import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabaseClient';
import type { Role } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import StatusPill from './ui/StatusPill';

interface FoundProfile {
  id: string;
  name: string | null;
  phone: string | null;
  role: Role;
  suspended: boolean;
}

export default function SuspendUserForm() {
  const { session } = useAuth();
  const [digits, setDigits] = useState('');
  const [found, setFound] = useState<FoundProfile | null | 'not_found'>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setError(null);
    setFound(null);
    if (digits.length < 4) {
      setError('Enter at least the last 4 digits of the phone number.');
      return;
    }
    setLoading(true);
    // Matched on the last digits typed rather than an exact "=", since
    // Supabase sometimes stores auth phone without a leading "+91" -
    // matches seed_test_clinic.sql's own workaround for the same quirk.
    const { data } = await supabase.from('profiles').select('*').ilike('phone', `%${digits}`).limit(1).maybeSingle();
    setLoading(false);
    setFound(data ?? 'not_found');
  };

  const toggleSuspended = async () => {
    if (!found || found === 'not_found' || !session) return;
    setError(null);
    const next = !found.suspended;
    const { error: updateError } = await supabase.from('profiles').update({ suspended: next }).eq('id', found.id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    await recordAdminDecision(
      session.user.id,
      next ? 'suspend_user' : 'reinstate_user',
      found.id,
      found.id,
      next
        ? 'Your account has been suspended. You can no longer make new bookings.'
        : 'Your account has been reinstated. You can make bookings again.'
    );
    setFound({ ...found, suspended: next });
  };

  return (
    <Card>
      <p className="text-sm font-semibold text-slate-900">Suspend a user</p>
      <p className="mt-1 text-xs text-slate-400">
        Blocks the account from creating new bookings (as a patient, or as a clinic entering walk-ins). Existing
        data is untouched.
      </p>
      <div className="mt-2 flex gap-2">
        <input
          type="tel"
          inputMode="numeric"
          value={digits}
          onChange={(e) => setDigits(e.target.value.replace(/\D/g, ''))}
          placeholder="Phone number (last digits)"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
        <Button onClick={search} disabled={loading}>
          {loading ? 'Searching...' : 'Find'}
        </Button>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {found === 'not_found' && <p className="mt-2 text-sm text-slate-400">No account found with that number.</p>}

      {found && found !== 'not_found' && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-slate-900">{found.name ?? found.phone}</p>
            <StatusPill label={found.suspended ? 'Suspended' : 'Active'} tone={found.suspended ? 'neutral' : 'live'} />
          </div>
          <p className="text-xs text-slate-500">
            {found.phone} · {found.role}
          </p>
          {found.role === 'admin' ? (
            <p className="mt-2 text-xs text-red-600">Admin accounts can't be suspended from here.</p>
          ) : (
            <Button
              variant={found.suspended ? 'secondary' : 'danger'}
              className="mt-2"
              onClick={toggleSuspended}
            >
              {found.suspended ? 'Reinstate account' : 'Suspend account'}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
