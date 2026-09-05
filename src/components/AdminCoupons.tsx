import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { Coupon, CouponFundedBy, CouponRedemptionStatus, CouponType } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import SectionTitle from './ui/SectionTitle';
import StatusPill from './ui/StatusPill';

interface ClinicOption {
  id: string;
  name: string;
}

interface RedemptionRow {
  id: string;
  discount_amount: number;
  status: CouponRedemptionStatus;
  created_at: string;
  coupons: { code: string; funded_by: CouponFundedBy } | null;
  appointments: { date: string; clinics: { name: string } | null } | null;
  profiles: { name: string | null; phone: string | null } | null;
}

// Blank draft for the create form, and what "Edit" seeds itself from -
// strings throughout (even for numbers/dates) since that's what <input>
// wants, converted on save.
interface CouponDraft {
  code: string;
  description: string;
  type: CouponType;
  value: string;
  maxDiscount: string;
  minAmount: string;
  validFrom: string;
  validTo: string;
  perUserLimit: string;
  totalLimit: string;
  fundedBy: CouponFundedBy;
  clinicId: string; // '' = every clinic
  active: boolean;
}

const BLANK_DRAFT: CouponDraft = {
  code: '',
  description: '',
  type: 'flat',
  value: '',
  maxDiscount: '',
  minAmount: '0',
  validFrom: '',
  validTo: '',
  perUserLimit: '',
  totalLimit: '',
  fundedBy: 'platform',
  clinicId: '',
  active: true,
};

function draftFromCoupon(c: Coupon): CouponDraft {
  return {
    code: c.code,
    description: c.description ?? '',
    type: c.type,
    value: String(c.value),
    maxDiscount: c.max_discount != null ? String(c.max_discount) : '',
    minAmount: String(c.min_amount),
    // <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM", not a full ISO
    // timestamp with seconds/timezone.
    validFrom: c.valid_from ? c.valid_from.slice(0, 16) : '',
    validTo: c.valid_to ? c.valid_to.slice(0, 16) : '',
    perUserLimit: c.per_user_limit != null ? String(c.per_user_limit) : '',
    totalLimit: c.total_limit != null ? String(c.total_limit) : '',
    fundedBy: c.funded_by,
    clinicId: c.clinic_id ?? '',
    active: c.active,
  };
}

// Parses an optional numeric field: '' -> null (unlimited/uncapped), a
// non-numeric string -> the error string given, otherwise the number.
function parseOptionalNumber(raw: string, label: string): number | null | string {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return `${label} must be a number.`;
  return n;
}

export default function AdminCoupons() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [redemptions, setRedemptions] = useState<RedemptionRow[]>([]);
  const [clinics, setClinics] = useState<ClinicOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CouponDraft>(BLANK_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const [{ data: couponData }, { data: redemptionData }, { data: clinicData }] = await Promise.all([
      supabase.from('coupons').select('*').order('created_at', { ascending: false }),
      supabase
        .from('coupon_redemptions')
        .select(
          'id, discount_amount, status, created_at, coupons(code, funded_by), appointments(date, clinics(name)), profiles(name, phone)'
        )
        .order('created_at', { ascending: false })
        .limit(100),
      supabase.from('clinics').select('id, name').order('name', { ascending: true }),
    ]);
    setCoupons((couponData ?? []) as Coupon[]);
    setRedemptions((redemptionData ?? []) as unknown as RedemptionRow[]);
    setClinics((clinicData ?? []) as ClinicOption[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const startCreate = () => {
    setEditingId(null);
    setDraft(BLANK_DRAFT);
    setError(null);
    setFormOpen(true);
  };

  const startEdit = (c: Coupon) => {
    setEditingId(c.id);
    setDraft(draftFromCoupon(c));
    setError(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setError(null);
  };

  const save = async () => {
    setError(null);
    const code = draft.code.trim().toUpperCase();
    if (!code) {
      setError('Enter a code.');
      return;
    }
    const value = Number(draft.value);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Value must be a positive number.');
      return;
    }
    if (draft.type === 'percent' && value > 100) {
      setError('A percent discount cannot exceed 100.');
      return;
    }
    const minAmount = Number(draft.minAmount || '0');
    if (!Number.isFinite(minAmount) || minAmount < 0) {
      setError('Minimum order amount must be 0 or more.');
      return;
    }
    const maxDiscount = parseOptionalNumber(draft.maxDiscount, 'Max discount');
    if (typeof maxDiscount === 'string') {
      setError(maxDiscount);
      return;
    }
    const perUserLimit = parseOptionalNumber(draft.perUserLimit, 'Per-user limit');
    if (typeof perUserLimit === 'string') {
      setError(perUserLimit);
      return;
    }
    const totalLimit = parseOptionalNumber(draft.totalLimit, 'Total limit');
    if (typeof totalLimit === 'string') {
      setError(totalLimit);
      return;
    }

    const patch = {
      code,
      description: draft.description.trim() || null,
      type: draft.type,
      value,
      max_discount: draft.type === 'percent' ? maxDiscount : null,
      min_amount: minAmount,
      valid_from: draft.validFrom ? new Date(draft.validFrom).toISOString() : null,
      valid_to: draft.validTo ? new Date(draft.validTo).toISOString() : null,
      per_user_limit: perUserLimit,
      total_limit: totalLimit,
      funded_by: draft.fundedBy,
      clinic_id: draft.clinicId || null,
      active: draft.active,
    };

    setSaving(true);
    const { error: saveError } = editingId
      ? await supabase.from('coupons').update(patch).eq('id', editingId)
      : await supabase.from('coupons').insert(patch);
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    closeForm();
    load();
  };

  const toggleActive = async (c: Coupon) => {
    await supabase.from('coupons').update({ active: !c.active }).eq('id', c.id);
    load();
  };

  const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Coupons</h2>
        <Button onClick={formOpen ? closeForm : startCreate}>{formOpen ? 'Cancel' : '+ New coupon'}</Button>
      </div>

      {formOpen && (
        <Card className="mt-3">
          <p className="text-sm font-bold text-slate-900">{editingId ? 'Edit coupon' : 'New coupon'}</p>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-bold text-slate-700">Code</label>
              <input
                type="text"
                value={draft.code}
                onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value.toUpperCase() }))}
                disabled={!!editingId}
                placeholder="WELCOME50"
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-50 disabled:text-slate-400"
              />
              {editingId && <p className="mt-0.5 text-[11px] text-slate-400">Code can't be changed once created.</p>}
            </div>

            <div className="col-span-2">
              <label className="text-xs font-bold text-slate-700">Description (internal)</label>
              <input
                type="text"
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                placeholder="e.g. New patient welcome offer"
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-slate-700">Type</label>
              <select
                value={draft.type}
                onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as CouponType }))}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="flat">Flat (₹)</option>
                <option value="percent">Percent (%)</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Value</label>
              <input
                type="number"
                min={0}
                value={draft.value}
                onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
                placeholder={draft.type === 'flat' ? '50' : '10'}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            {draft.type === 'percent' && (
              <div>
                <label className="text-xs font-bold text-slate-700">Max discount (₹, optional)</label>
                <input
                  type="number"
                  min={0}
                  value={draft.maxDiscount}
                  onChange={(e) => setDraft((d) => ({ ...d, maxDiscount: e.target.value }))}
                  placeholder="No cap"
                  className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            )}
            <div>
              <label className="text-xs font-bold text-slate-700">Minimum order (₹)</label>
              <input
                type="number"
                min={0}
                value={draft.minAmount}
                onChange={(e) => setDraft((d) => ({ ...d, minAmount: e.target.value }))}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-slate-700">Valid from (optional)</label>
              <input
                type="datetime-local"
                value={draft.validFrom}
                onChange={(e) => setDraft((d) => ({ ...d, validFrom: e.target.value }))}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Valid to (optional)</label>
              <input
                type="datetime-local"
                value={draft.validTo}
                onChange={(e) => setDraft((d) => ({ ...d, validTo: e.target.value }))}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-slate-700">Per-user limit (optional)</label>
              <input
                type="number"
                min={1}
                value={draft.perUserLimit}
                onChange={(e) => setDraft((d) => ({ ...d, perUserLimit: e.target.value }))}
                placeholder="Unlimited"
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Total limit (optional)</label>
              <input
                type="number"
                min={1}
                value={draft.totalLimit}
                onChange={(e) => setDraft((d) => ({ ...d, totalLimit: e.target.value }))}
                placeholder="Unlimited"
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-slate-700">Funded by</label>
              <select
                value={draft.fundedBy}
                onChange={(e) => setDraft((d) => ({ ...d, fundedBy: e.target.value as CouponFundedBy }))}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="platform">Platform</option>
                <option value="clinic">Clinic</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Restrict to clinic (optional)</label>
              <select
                value={draft.clinicId}
                onChange={(e) => setDraft((d) => ({ ...d, clinicId: e.target.value }))}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">All clinics</option>
                {clinics.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <label className="col-span-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <input
                type="checkbox"
                checked={draft.active}
                onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))}
                className="h-4 w-4"
              />
              Active
            </label>
          </div>

          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <div className="mt-3 flex gap-2">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving...' : editingId ? 'Save changes' : 'Create coupon'}
            </Button>
            <Button variant="ghost" onClick={closeForm}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      <SectionTitle className="mt-6" actionLabel="Refresh" onAction={load}>
        All coupons
      </SectionTitle>
      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && coupons.length === 0 && <p className="text-sm text-slate-400">No coupons yet.</p>}
        {coupons.map((c) => (
          <Card key={c.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-extrabold text-slate-900">{c.code}</p>
                {c.description && <p className="truncate text-xs text-slate-500">{c.description}</p>}
              </div>
              <StatusPill label={c.active ? 'Active' : 'Inactive'} tone={c.active ? 'live' : 'neutral'} />
            </div>
            <p className="mt-1.5 text-sm text-slate-600">
              {c.type === 'flat' ? `₹${c.value} off` : `${c.value}% off${c.max_discount ? ` (capped at ₹${c.max_discount})` : ''}`}
              {c.min_amount > 0 && <> · min order {rupees(c.min_amount)}</>}
            </p>
            <p className="text-xs text-slate-400">
              Used {c.times_used}
              {c.total_limit != null ? `/${c.total_limit}` : ''} total · {c.per_user_limit ?? 'unlimited'} per patient
              · funded by {c.funded_by}
              {c.clinic_id && <> · restricted to one clinic</>}
            </p>
            {(c.valid_from || c.valid_to) && (
              <p className="text-xs text-slate-400">
                {c.valid_from ? new Date(c.valid_from).toLocaleString() : 'Always'} →{' '}
                {c.valid_to ? new Date(c.valid_to).toLocaleString() : 'No end date'}
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <button onClick={() => startEdit(c)} className="text-xs font-bold text-brand-600">
                Edit
              </button>
              <button onClick={() => toggleActive(c)} className="text-xs font-bold text-slate-500">
                {c.active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </Card>
        ))}
      </div>

      <SectionTitle className="mt-6" actionLabel="Refresh" onAction={load}>
        Recent redemptions
      </SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">Who used what, and who's funding the discount.</p>
      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && redemptions.length === 0 && <p className="text-sm text-slate-400">No redemptions yet.</p>}
        {redemptions.map((r) => (
          <Card key={r.id}>
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-sm font-bold text-slate-900">{r.coupons?.code ?? '—'}</p>
              <StatusPill
                label={r.status}
                tone={r.status === 'confirmed' ? 'live' : r.status === 'reserved' ? 'warning' : 'neutral'}
              />
            </div>
            <p className="text-sm text-slate-600">
              {r.profiles?.name ?? 'Patient'} {r.profiles?.phone ? `(+${r.profiles.phone})` : ''} · -₹{r.discount_amount}
            </p>
            <p className="text-xs text-slate-400">
              {r.appointments?.clinics?.name ?? 'No clinic yet'}
              {r.appointments?.date ? ` · ${r.appointments.date}` : ''} · funded by{' '}
              {r.coupons?.funded_by ?? '—'} · {new Date(r.created_at).toLocaleString()}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}
