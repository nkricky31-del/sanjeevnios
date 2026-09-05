import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { BillingStatus } from '../lib/types';
import Card from './ui/Card';
import SectionTitle from './ui/SectionTitle';
import StatusPill from './ui/StatusPill';

interface ClinicSubscription {
  billing_status: BillingStatus;
  current_period_end: string | null;
  // plans is a plain to-one FK (subscriptions.plan_id -> plans.id), always a
  // single object or null - only `subscriptions` itself needs the
  // to-one-or-array defensiveness below (see AdminSubscriptions.tsx's own
  // note on why: PostgREST's array-vs-object shape here has varied by version).
  plans: { name: string } | null;
}

interface ClinicRow {
  id: string;
  name: string;
  is_active: boolean;
  subscriptions: ClinicSubscription | ClinicSubscription[] | null;
}

interface InvoiceRow {
  id: string;
  amount: number;
  status: 'paid' | 'failed';
  period_start: string;
  period_end: string;
  created_at: string;
  clinics: { name: string } | null;
}

interface CommissionRow {
  id: string;
  net_amount: number;
  commission_rate: number;
  platform_fee: number;
  created_at: string;
  clinics: { name: string } | null;
}

function oneSubscription<T>(subs: T | T[] | null): T | null {
  if (!subs) return null;
  return Array.isArray(subs) ? (subs[0] ?? null) : subs;
}

const FETCH_LIMIT = 200;

export default function AdminBilling() {
  const [clinics, setClinics] = useState<ClinicRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [commissions, setCommissions] = useState<CommissionRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [{ data: clinicData }, { data: invoiceData }, { data: commissionData }] = await Promise.all([
      supabase
        .from('clinics')
        .select('id, name, is_active, subscriptions(billing_status, current_period_end, plans(name))')
        .order('name', { ascending: true }),
      supabase
        .from('invoices')
        .select('id, amount, status, period_start, period_end, created_at, clinics(name)')
        .order('created_at', { ascending: false })
        .limit(FETCH_LIMIT),
      supabase
        .from('commission_ledger')
        .select('id, net_amount, commission_rate, platform_fee, created_at, clinics(name)')
        .order('created_at', { ascending: false })
        .limit(FETCH_LIMIT),
    ]);
    setClinics((clinicData ?? []) as unknown as ClinicRow[]);
    setInvoices((invoiceData ?? []) as unknown as InvoiceRow[]);
    setCommissions((commissionData ?? []) as unknown as CommissionRow[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const subscriptionRevenue = invoices.filter((i) => i.status === 'paid').reduce((sum, i) => sum + i.amount, 0);
  const commissionRevenue = commissions.reduce((sum, c) => sum + c.platform_fee, 0);
  const totalRevenue = subscriptionRevenue + commissionRevenue;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Billing</h2>
        <button onClick={load} className="text-sm font-medium text-brand-600">
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Every clinic's plan and renewal, the invoice/commission ledgers, and total platform revenue. Only the last{' '}
        {FETCH_LIMIT} rows of each ledger are shown here.
      </p>

      <Card className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Total revenue</p>
        <p className="mt-1 text-2xl font-extrabold text-slate-900">₹{totalRevenue.toLocaleString('en-IN')}</p>
        <p className="mt-1 text-xs text-slate-500">
          ₹{subscriptionRevenue.toLocaleString('en-IN')} subscriptions + ₹{commissionRevenue.toLocaleString('en-IN')}{' '}
          commissions
        </p>
      </Card>

      <SectionTitle className="mt-6">Clinics</SectionTitle>
      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && clinics.length === 0 && <p className="text-sm text-slate-400">No clinics yet.</p>}
        {clinics.map((c) => {
          const sub = oneSubscription(c.subscriptions);
          return (
            <Card key={c.id}>
              <div className="flex items-center justify-between">
                <p className="font-semibold text-slate-900">{c.name}</p>
                <div className="flex gap-1">
                  <StatusPill label={c.is_active ? 'Active' : 'Inactive'} tone={c.is_active ? 'live' : 'neutral'} />
                  {sub?.billing_status === 'past_due' && <StatusPill label="Past due" tone="danger" />}
                </div>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                {sub?.plans?.name ?? 'No plan'}
                {sub?.current_period_end && <> · renews {new Date(sub.current_period_end).toLocaleDateString()}</>}
              </p>
            </Card>
          );
        })}
      </div>

      <SectionTitle className="mt-6">Invoices</SectionTitle>
      <div className="mt-2 space-y-2">
        {!loading && invoices.length === 0 && <p className="text-sm text-slate-400">No invoices yet.</p>}
        {invoices.map((inv) => (
          <Card key={inv.id}>
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-900">
                {inv.clinics?.name ?? 'Unknown clinic'} · ₹{inv.amount}
              </p>
              <StatusPill label={inv.status} tone={inv.status === 'paid' ? 'live' : 'danger'} />
            </div>
            <p className="text-xs text-slate-400">
              {new Date(inv.period_start).toLocaleDateString()} → {new Date(inv.period_end).toLocaleDateString()} ·{' '}
              {new Date(inv.created_at).toLocaleString()}
            </p>
          </Card>
        ))}
      </div>

      <SectionTitle className="mt-6">Commissions</SectionTitle>
      <div className="mt-2 space-y-2">
        {!loading && commissions.length === 0 && <p className="text-sm text-slate-400">No commissions recorded yet.</p>}
        {commissions.map((c) => (
          <Card key={c.id}>
            <p className="font-semibold text-slate-900">
              {c.clinics?.name ?? 'Unknown clinic'} · ₹{c.platform_fee.toFixed(2)}
            </p>
            <p className="text-xs text-slate-400">
              {(c.commission_rate * 100).toFixed(1)}% of ₹{c.net_amount} · {new Date(c.created_at).toLocaleString()}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}
