import { useEffect, useState } from 'react';

import { useAuth } from '../lib/AuthContext';
import { createRazorpaySubscription, loadRazorpayScript, openRazorpaySubscriptionCheckout } from '../lib/razorpay';
import { supabase } from '../lib/supabaseClient';
import type { Invoice, Plan, Subscription } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import SectionTitle from './ui/SectionTitle';
import StatusPill from './ui/StatusPill';

interface Props {
  clinicId: string;
}

export default function ClinicBilling({ clinicId }: Props) {
  const { profile } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const [{ data: planData }, { data: subData }, { data: invoiceData }] = await Promise.all([
      supabase.from('plans').select('*').eq('active', true).order('monthly_price', { ascending: true }),
      supabase.from('subscriptions').select('*').eq('clinic_id', clinicId).maybeSingle(),
      supabase
        .from('invoices')
        .select('*')
        .eq('clinic_id', clinicId)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);
    setPlans((planData ?? []) as Plan[]);
    setSubscription((subData ?? null) as Subscription | null);
    setInvoices((invoiceData ?? []) as Invoice[]);
    setSelectedPlanId((prev) => prev || (subData as Subscription | null)?.plan_id || (planData ?? [])[0]?.id || '');
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  const currentPlan = plans.find((p) => p.id === subscription?.plan_id) ?? null;
  const pastDue = subscription?.billing_status === 'past_due';

  const subscribe = async () => {
    setError(null);
    setNote(null);
    if (!selectedPlanId) {
      setError('Pick a plan first.');
      return;
    }
    setSubscribing(true);

    const plan = plans.find((p) => p.id === selectedPlanId);
    // A free plan is assigned directly server-side - Razorpay is never
    // involved (its API rejects a zero-amount subscription outright, and
    // there's nothing to charge for anyway), so Checkout never opens for it.
    const isFreePlan = (plan?.monthly_price ?? 0) <= 0;

    if (!isFreePlan) {
      const scriptOk = await loadRazorpayScript();
      if (!scriptOk) {
        setSubscribing(false);
        setError('Could not load the payment gateway. Check your connection and try again.');
        return;
      }
    }

    const result = await createRazorpaySubscription(clinicId, selectedPlanId);
    if ('error' in result) {
      setSubscribing(false);
      setError(result.error);
      return;
    }

    if ('assignedDirectly' in result && result.assignedDirectly) {
      setSubscribing(false);
      setNote(`You're now on the ${plan?.name ?? 'selected'} plan.`);
      load();
      return;
    }
    openRazorpaySubscriptionCheckout({
      keyId: result.keyId,
      subscriptionId: result.subscriptionId,
      planName: plan?.name ?? 'Subscription',
      ownerPhone: profile?.phone,
      onSuccess: () => {
        setSubscribing(false);
        setNote(
          "Payment submitted - we're confirming with Razorpay now. This usually takes a few seconds; refresh if your plan doesn't update right away."
        );
        // The webhook is what actually activates this (see razorpay-webhook's
        // header) - refreshing here just picks up that update once it lands,
        // rather than claiming success ourselves.
        load();
      },
      onDismiss: () => {
        setSubscribing(false);
        setError('Subscription setup was not completed. You can try again anytime.');
      },
    });
  };

  if (loading) return <p className="text-sm text-slate-400">Loading...</p>;

  return (
    <div>
      <SectionTitle>Billing</SectionTitle>

      {pastDue && (
        <div className="mt-2 rounded-2xl bg-red-50 p-3.5 text-sm text-red-800">
          <p className="font-bold">Payment past due</p>
          <p className="mt-1 text-xs leading-relaxed">
            Your last renewal didn't go through. Razorpay will keep retrying automatically - if every retry fails,
            your clinic will be hidden from patient search and can't accept new bookings until you resubscribe.
          </p>
        </div>
      )}

      <Card className="mt-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-slate-900">Current plan</p>
          <StatusPill label={pastDue ? 'Past due' : 'Active'} tone={pastDue ? 'danger' : 'live'} />
        </div>
        <p className="mt-1 text-lg font-extrabold text-slate-900">{currentPlan?.name ?? 'No plan yet'}</p>
        {currentPlan && (
          <p className="text-sm text-slate-500">
            ₹{currentPlan.monthly_price}/month ·{' '}
            {currentPlan.booking_limit != null ? `${currentPlan.booking_limit} bookings/month` : 'Unlimited bookings'}
            {currentPlan.per_booking_commission > 0 && ` · ${currentPlan.per_booking_commission * 100}% commission`}
          </p>
        )}
        {subscription?.current_period_end && (
          <p className="mt-1 text-xs text-slate-400">
            Next renewal: {new Date(subscription.current_period_end).toLocaleDateString()}
          </p>
        )}
        {!subscription?.razorpay_subscription_id && (
          <p className="mt-1 text-xs text-slate-400">Not yet subscribed via Razorpay - pick a plan below to start.</p>
        )}
      </Card>

      <div className="mt-4">
        <label className="text-xs font-bold text-slate-700">
          {subscription?.razorpay_subscription_id ? 'Switch plan' : 'Choose a plan'}
        </label>
        <select
          value={selectedPlanId}
          onChange={(e) => setSelectedPlanId(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        >
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} - ₹{p.monthly_price}/month
            </option>
          ))}
        </select>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        {note && <p className="mt-2 text-sm font-semibold text-emerald-600">{note}</p>}
        <Button onClick={subscribe} disabled={subscribing} className="mt-3">
          {subscribing ? 'Starting...' : subscription?.razorpay_subscription_id ? 'Change plan' : 'Subscribe'}
        </Button>
      </div>

      <SectionTitle className="mt-6" actionLabel="Refresh" onAction={load}>
        Invoices
      </SectionTitle>
      <div className="mt-2 space-y-2">
        {invoices.length === 0 && <p className="text-sm text-slate-400">No invoices yet.</p>}
        {invoices.map((inv) => (
          <Card key={inv.id}>
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-900">₹{inv.amount}</p>
              <StatusPill label={inv.status} tone={inv.status === 'paid' ? 'live' : 'danger'} />
            </div>
            <p className="text-xs text-slate-400">
              {new Date(inv.period_start).toLocaleDateString()} → {new Date(inv.period_end).toLocaleDateString()}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}
