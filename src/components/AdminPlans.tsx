import Loading from './ui/Loading';
import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { Plan } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import SectionTitle from './ui/SectionTitle';

interface Draft {
  monthly_price: string;
  min_doctors: string;
  max_doctors: string; // '' = no maximum (the top tier)
}

const toDraft = (p: Plan): Draft => ({
  monthly_price: String(p.monthly_price),
  min_doctors: String(p.min_doctors),
  max_doctors: p.max_doctors == null ? '' : String(p.max_doctors),
});

const isWholeNumber = (v: string) => /^\d+$/.test(v.trim());

// The same rules admin_save_plans() (migration 66) enforces, checked here
// first so the admin sees the problem while editing instead of only after
// pressing Save. The database check is still the one that actually counts.
function validate(plans: Plan[], drafts: Record<string, Draft>): string | null {
  const rows = plans.map((p) => ({ name: p.name, ...drafts[p.id] }));
  for (const r of rows) {
    if (r.monthly_price.trim() === '' || Number.isNaN(Number(r.monthly_price)) || Number(r.monthly_price) < 0) {
      return `${r.name}: enter a monthly price of 0 or more.`;
    }
    if (!isWholeNumber(r.min_doctors) || Number(r.min_doctors) < 1) {
      return `${r.name}: "From" must be a whole number, at least 1.`;
    }
    if (r.max_doctors.trim() !== '' && (!isWholeNumber(r.max_doctors) || Number(r.max_doctors) < Number(r.min_doctors))) {
      return `${r.name}: "To" must be a whole number no lower than "From", or left blank for no limit.`;
    }
  }
  const sorted = [...rows].sort((a, b) => Number(a.min_doctors) - Number(b.min_doctors));
  if (sorted.length && Number(sorted[0].min_doctors) !== 1) {
    return `${sorted[0].name} must start at 1 doctor, so a single-doctor clinic has a plan.`;
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (prev.max_doctors.trim() === '') {
      return `Only the largest plan can have no limit - ${prev.name} is blank but ${sorted[i].name} comes after it.`;
    }
    const expected = Number(prev.max_doctors) + 1;
    if (Number(sorted[i].min_doctors) !== expected) {
      return `${sorted[i].name} must start at ${expected} doctors, right after ${prev.name} ends at ${prev.max_doctors}.`;
    }
  }
  if (sorted.length && sorted[sorted.length - 1].max_doctors.trim() !== '') {
    return `Leave "To" blank on ${sorted[sorted.length - 1].name} so clinics of any size have a plan.`;
  }
  return null;
}

// Edits every active plan's price and doctor band (migration 62's tiers)
// together - moving a band edge always changes two plans at once, so they're
// saved as one set through admin_save_plans().
export default function AdminPlans({ onSaved }: { onSaved?: () => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error: loadError } = await supabase.from('plans').select('*').eq('active', true).order('min_doctors');
    if (loadError) setError(`Couldn't load plans: ${loadError.message}`);
    const rows = (data ?? []) as Plan[];
    setPlans(rows);
    setDrafts(Object.fromEntries(rows.map((p) => [p.id, toDraft(p)])));
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const setField = (id: string, field: keyof Draft, value: string) => {
    setSaved(false);
    setError(null);
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const dirty = plans.some((p) => {
    const d = drafts[p.id];
    const o = toDraft(p);
    return d && (d.monthly_price !== o.monthly_price || d.min_doctors !== o.min_doctors || d.max_doctors !== o.max_doctors);
  });
  const problem = plans.length ? validate(plans, drafts) : null;

  const save = async () => {
    if (problem) return;
    setSaving(true);
    setError(null);
    const payload = plans.map((p) => ({
      id: p.id,
      monthly_price: Number(drafts[p.id].monthly_price),
      min_doctors: Number(drafts[p.id].min_doctors),
      max_doctors: drafts[p.id].max_doctors.trim() === '' ? null : Number(drafts[p.id].max_doctors),
    }));
    const { error: rpcError } = await supabase.rpc('admin_save_plans', { p_plans: payload });
    setSaving(false);
    if (rpcError) {
      setError(`Plans weren't saved: ${rpcError.message}`);
      return;
    }
    setSaved(true);
    load();
    onSaved?.();
  };

  const inputClass =
    'mt-1 w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500';

  return (
    <div>
      <SectionTitle className="mt-6">Plans</SectionTitle>
      <p className="mt-1 text-xs text-slate-400">
        Each plan covers a range of verified, active doctors. Ranges must start at 1, follow on with no gaps, and the
        largest plan has no upper limit. A clinic moves up the moment a new doctor needs a bigger plan, and down at its
        next billing cycle.
      </p>

      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400"><Loading /></p>}
        {!loading &&
          plans.map((p) => {
            const d = drafts[p.id];
            if (!d) return null;
            const priceChanged = d.monthly_price !== String(p.monthly_price);
            return (
              <Card key={p.id}>
                <p className="font-semibold text-slate-900">{p.name}</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <label className="text-xs font-medium text-slate-500">
                    Monthly price (₹)
                    <input
                      inputMode="decimal"
                      value={d.monthly_price}
                      onChange={(e) => setField(p.id, 'monthly_price', e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-500">
                    From (doctors)
                    <input
                      inputMode="numeric"
                      value={d.min_doctors}
                      onChange={(e) => setField(p.id, 'min_doctors', e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-500">
                    To (doctors)
                    <input
                      inputMode="numeric"
                      value={d.max_doctors}
                      placeholder="No limit"
                      onChange={(e) => setField(p.id, 'max_doctors', e.target.value)}
                      className={inputClass}
                    />
                  </label>
                </div>
                {p.razorpay_plan_id && priceChanged && (
                  <p className="mt-2 text-xs text-amber-700">
                    This plan is linked to a Razorpay plan, and Razorpay keeps charging that plan's own amount. To bill
                    the new price, create a new Razorpay plan at this price and link it here.
                  </p>
                )}
              </Card>
            );
          })}
      </div>

      {dirty && problem && <p className="mt-2 text-sm text-red-600">{problem}</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {saved && !dirty && <p className="mt-2 text-sm text-emerald-600">Plans saved.</p>}

      {!loading && plans.length > 0 && (
        <div className="mt-2 flex gap-2">
          <Button onClick={save} disabled={!dirty || !!problem || saving}>
            {saving ? 'Saving...' : 'Save plans'}
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setDrafts(Object.fromEntries(plans.map((p) => [p.id, toDraft(p)])))}>
              Discard changes
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
