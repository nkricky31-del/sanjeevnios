import Present from './ui/Present';
import AdminDrill, { type DrillView } from './AdminDrill';
import Loading from './ui/Loading';
import { useEffect, useState } from 'react';

import { recordAdminDecision } from '../lib/audit';
import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabaseClient';
import AdminRejectForm from './AdminRejectForm';
import Button from './ui/Button';
import Card from './ui/Card';
import StatusPill from './ui/StatusPill';

interface PaymentRow {
  id: string;
  appointment_id: string;
  amount: number;
  method: 'online' | 'cod';
  status: 'pending' | 'hold' | 'captured' | 'refunded';
  payout_status: 'pending' | 'paid';
  gross_amount: number | null;
  coupon_code: string | null;
  discount_amount: number;
  funded_by: 'platform' | 'clinic' | null;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  created_at: string;
  appointments: {
    clinic_id: string;
    date: string;
    slot_time: string;
    clinics: { name: string } | null;
    family_members: { name: string; account_id: string } | null;
  } | null;
}

const STATUS_TONE: Record<PaymentRow['status'], 'live' | 'warning' | 'info' | 'neutral' | 'danger' | 'violet'> = {
  pending: 'warning',
  hold: 'danger',
  captured: 'live',
  refunded: 'violet',
};

// Recent-payments cap for this MVP admin view - large enough to cover
// realistic test/demo volume without pulling the whole table every load.
const FETCH_LIMIT = 500;

export default function AdminPayments() {
  const { session } = useAuth();
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [drill, setDrill] = useState<DrillView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refundOpenFor, setRefundOpenFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('payments')
      .select('*, appointments(clinic_id, date, slot_time, clinics(name), family_members(name, account_id))')
      .order('created_at', { ascending: false })
      .limit(FETCH_LIMIT);
    setPayments((data ?? []) as unknown as PaymentRow[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const reversePayment = async (payment: PaymentRow, reason: string) => {
    setActionError(null);
    if (!session) return;

    const { error } = await supabase.from('payments').update({ status: 'refunded' }).eq('id', payment.id);
    if (error) {
      setActionError(error.message);
      return;
    }
    await supabase.from('appointments').update({ payment_status: 'refunded' }).eq('id', payment.appointment_id);

    const accountId = payment.appointments?.family_members?.account_id;
    if (accountId) {
      await recordAdminDecision(
        session.user.id,
        'reverse_payment',
        payment.id,
        accountId,
        `A payment of ₹${payment.amount} has been reversed: "${reason}"`
      );
    }
    setRefundOpenFor(null);
    load();
  };

  if (drill) return <AdminDrill view={drill} onChange={setDrill} onClose={() => setDrill(null)} />;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Payments</h2>
        <button onClick={load} className="text-sm font-medium text-brand-600">
          Refresh
        </button>
      </div>
      {actionError && <p className="mt-2 text-sm text-red-600">{actionError}</p>}

      <div className="mt-3 rounded-2xl bg-brand-50 p-3 text-xs text-brand-800">
        Clinic payouts moved to the <strong>Settlements</strong> tab - a payment is only released to a clinic once
        its visit is completed, with a running ledger of what's eligible, released, and settled.
      </div>

      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-slate-400">Recent payments</p>
      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400"><Loading /></p>}
        {!loading && payments.length === 0 && <p className="text-sm text-slate-400">No payments yet.</p>}
        {payments.slice(0, 30).map((p) => (
          <Card key={p.id} onOpen={() => setDrill({ kind: 'payment', id: p.id })} accent={p.status === 'captured' ? '#10b981' : p.status === 'refunded' ? '#8b5cf6' : p.status === 'hold' ? '#f43f5e' : '#f59e0b'}>
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-900">₹{p.amount}</p>
              <div className="flex items-center gap-2">
                <StatusPill label={p.status} tone={STATUS_TONE[p.status]} />
              </div>
            </div>
            <p className="text-sm text-slate-500">
              {p.appointments?.clinics?.name} · {p.appointments?.family_members?.name}
            </p>
            <p className="text-xs text-slate-400">
              {p.appointments?.date} at {p.appointments?.slot_time?.slice(0, 5)} · {p.method}
            </p>
            {p.coupon_code && (
              <p className="text-xs text-emerald-600">
                Coupon {p.coupon_code}: ₹{p.gross_amount ?? p.amount} → ₹{p.amount} (-₹{p.discount_amount})
              </p>
            )}
            {p.razorpay_payment_id && (
              <p className="truncate font-mono text-[11px] text-slate-400">rzp: {p.razorpay_payment_id}</p>
            )}
            {p.status === 'captured' && (
              <>
                <Button
                  variant="danger"
                  className="mt-2"
                  onClick={() => setRefundOpenFor((prev) => (prev === p.id ? null : p.id))}
                >
                  {refundOpenFor === p.id ? 'Cancel' : 'Reverse payment'}
                </Button>
                <Present show={refundOpenFor === p.id}>
                  <AdminRejectForm
                    label="Reason for reversing this payment (shown to the patient)"
                    onConfirm={(reason) => reversePayment(p, reason)}
                    onCancel={() => setRefundOpenFor(null)}
                  />
                </Present>
              </>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
