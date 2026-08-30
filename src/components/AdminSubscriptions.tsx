import { useEffect, useState } from 'react';

import { recordAdminDecision } from '../lib/audit';
import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { TIER_ORDER, TIERS, usageStatus } from '../lib/subscription';
import type { ClinicStatus, Subscription, SubscriptionTier } from '../lib/types';
import Card from './ui/Card';
import StatusPill from './ui/StatusPill';

interface ClinicRow {
  id: string;
  name: string;
  status: ClinicStatus;
  is_active: boolean;
  owner_id: string;
  // Now that subscriptions.clinic_id is unique, PostgREST reports this as a
  // to-one relationship (a single object or null) rather than an array -
  // handled defensively below since that shape can vary by PostgREST version.
  subscriptions: Subscription[] | Subscription | null;
}

function firstSubscription(subs: ClinicRow['subscriptions']): Subscription | null {
  if (!subs) return null;
  return Array.isArray(subs) ? (subs[0] ?? null) : subs;
}

const USAGE_TONE: Record<'ok' | 'near_limit' | 'over_limit', 'live' | 'warning' | 'neutral'> = {
  ok: 'live',
  near_limit: 'warning',
  over_limit: 'neutral',
};

const USAGE_LABEL: Record<'ok' | 'near_limit' | 'over_limit', string> = {
  ok: 'OK',
  near_limit: 'Near limit',
  over_limit: 'Over limit',
};

export default function AdminSubscriptions() {
  const { session } = useAuth();
  const [clinics, setClinics] = useState<ClinicRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('clinics')
      .select('id, name, status, is_active, owner_id, subscriptions(*)')
      .order('name', { ascending: true });
    setClinics((data ?? []) as unknown as ClinicRow[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const changeTier = async (clinic: ClinicRow, tier: SubscriptionTier) => {
    setActionError(null);
    if (!session) return;
    const { error } = await supabase.from('subscriptions').upsert({ clinic_id: clinic.id, tier }, { onConflict: 'clinic_id' });
    if (error) {
      setActionError(error.message);
      return;
    }
    await recordAdminDecision(
      session.user.id,
      'change_tier',
      clinic.id,
      clinic.owner_id,
      `Your clinic "${clinic.name}" has been moved to the ${TIERS[tier].label} plan.`
    );
    load();
  };

  const toggleActive = async (clinic: ClinicRow) => {
    setActionError(null);
    if (!session) return;
    const nextActive = !clinic.is_active;
    const { error } = await supabase.from('clinics').update({ is_active: nextActive }).eq('id', clinic.id);
    if (error) {
      setActionError(error.message);
      return;
    }
    await recordAdminDecision(
      session.user.id,
      nextActive ? 'activate_clinic' : 'deactivate_clinic',
      clinic.id,
      clinic.owner_id,
      nextActive
        ? `Your clinic "${clinic.name}" has been reactivated and can accept bookings again.`
        : `Your clinic "${clinic.name}" has been deactivated and can no longer accept new bookings.`
    );
    load();
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Subscriptions</h2>
        <button onClick={load} className="text-sm font-medium text-brand-600">
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">Plan, usage, and access status for every clinic.</p>

      {actionError && <p className="mt-2 text-sm text-red-600">{actionError}</p>}

      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && clinics.length === 0 && <p className="text-sm text-slate-400">No clinics yet.</p>}
        {clinics.map((c) => {
          const sub = firstSubscription(c.subscriptions);
          const tier = sub?.tier ?? 'free';
          const bookingsUsed = sub?.bookings_used ?? 0;
          const limit = TIERS[tier].monthlyBookingLimit;
          const status = usageStatus(tier, bookingsUsed);

          return (
            <Card key={c.id}>
              <div className="flex items-center justify-between">
                <p className="font-semibold text-slate-900">{c.name}</p>
                <div className="flex gap-1">
                  <StatusPill label={c.status} tone={c.status === 'approved' ? 'live' : 'neutral'} />
                  <StatusPill label={c.is_active ? 'Active' : 'Inactive'} tone={c.is_active ? 'live' : 'neutral'} />
                </div>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <label className="text-xs font-medium text-slate-600">Plan</label>
                <select
                  value={tier}
                  onChange={(e) => changeTier(c, e.target.value as SubscriptionTier)}
                  className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
                >
                  {TIER_ORDER.map((t) => (
                    <option key={t} value={t}>
                      {TIERS[t].label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => toggleActive(c)}
                  className={`ml-auto text-xs font-semibold ${c.is_active ? 'text-red-600' : 'text-emerald-600'}`}
                >
                  {c.is_active ? 'Deactivate' : 'Activate'}
                </button>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-slate-700">
                  Bookings this period: {bookingsUsed}
                  {limit != null ? ` / ${limit}` : ' (unlimited)'}
                </span>
                <StatusPill label={USAGE_LABEL[status]} tone={USAGE_TONE[status]} />
              </div>
              {sub?.period_start && sub?.period_end && (
                <p className="mt-1 text-xs text-slate-400">
                  Period: {sub.period_start} → {sub.period_end}
                </p>
              )}
              {!sub && <p className="mt-1 text-xs text-slate-400">No usage yet this period.</p>}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
