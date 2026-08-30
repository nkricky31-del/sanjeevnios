import { useEffect, useState } from 'react';

import { recordAdminDecision } from '../lib/audit';
import { useAuth } from '../lib/AuthContext';
import { computePayouts, type PayoutPaymentRow } from '../lib/payouts';
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
  created_at: string;
  appointments: {
    clinic_id: string;
    date: string;
    slot_time: string;
    clinics: { name: string } | null;
    family_members: { name: string; account_id: string } | null;
  } | null;
}

const STATUS_TONE: Record<PaymentRow['status'], 'live' | 'warning' | 'info' | 'neutral'> = {
  pending: 'neutral',
  hold: 'warning',
  captured: 'live',
  refunded: 'info',
};

// Recent-payments cap for this MVP admin view - large enough to cover
// realistic test/demo volume without pulling the whole table every load.
const FETCH_LIMIT = 500;

export default function AdminPayments() {
  const { session } = useAuth();
  const [payments, setPayments] = useState<PaymentRow[]>([]);
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

  const payouts = computePayouts(payments as unknown as PayoutPaymentRow[]);

  const markPayoutPaid = async (clinicId: string) => {
    setActionError(null);
    const { data: appts } = await supabase.from('appointments').select('id').eq('clinic_id', clinicId);
    const apptIds = (appts ?? []).map((a) => a.id);
    if (apptIds.length === 0) return;
    const { error } = await supabase
      .from('payments')
      .update({ payout_status: 'paid' })
      .in('appointment_id', apptIds)
      .eq('status', 'captured')
      .eq('payout_status', 'pending');
    if (error) {
      setActionError(error.message);
      return;
    }
    load();
  };

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

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Payments</h2>
        <button onClick={load} className="text-sm font-medium text-blue-600">
          Refresh
        </button>
      </div>
      {actionError && <p className="mt-2 text-sm text-red-600">{actionError}</p>}

      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Clinic payouts</p>
      <p className="text-xs text-slate-400">Online payments collected, minus platform fee. COD is paid to the clinic directly.</p>
      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && payouts.length === 0 && <p className="text-sm text-slate-400">No captured payments yet.</p>}
        {payouts.map((p) => (
          <Card key={p.clinicId}>
            <p className="font-semibold text-slate-900">{p.clinicName}</p>
            <p className="text-sm text-slate-600">Collected: ₹{p.collected.toLocaleString()}</p>
            <p className="text-sm text-slate-600">Platform fee: ₹{p.fee.toLocaleString()}</p>
            <p className="text-sm font-semibold text-emerald-700">Owed to clinic: ₹{p.owed.toLocaleString()}</p>
            <p className="mt-1 text-xs text-slate-400">
              {p.pendingPayoutCount} payment{p.pendingPayoutCount === 1 ? '' : 's'} pending payout ·{' '}
              {p.paidPayoutCount} already paid
            </p>
            {p.pendingPayoutCount > 0 && (
              <Button className="mt-2" onClick={() => markPayoutPaid(p.clinicId)}>
                Mark payout as paid
              </Button>
            )}
          </Card>
        ))}
      </div>

      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-slate-400">Recent payments</p>
      <div className="mt-2 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && payments.length === 0 && <p className="text-sm text-slate-400">No payments yet.</p>}
        {payments.slice(0, 30).map((p) => (
          <Card key={p.id}>
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-900">₹{p.amount}</p>
              <StatusPill label={p.status} tone={STATUS_TONE[p.status]} />
            </div>
            <p className="text-sm text-slate-500">
              {p.appointments?.clinics?.name} · {p.appointments?.family_members?.name}
            </p>
            <p className="text-xs text-slate-400">
              {p.appointments?.date} at {p.appointments?.slot_time?.slice(0, 5)} · {p.method} · payout:{' '}
              {p.payout_status}
            </p>
            {p.status === 'captured' && (
              <>
                <Button
                  variant="danger"
                  className="mt-2"
                  onClick={() => setRefundOpenFor((prev) => (prev === p.id ? null : p.id))}
                >
                  {refundOpenFor === p.id ? 'Cancel' : 'Reverse payment'}
                </Button>
                {refundOpenFor === p.id && (
                  <AdminRejectForm
                    label="Reason for reversing this payment (shown to the patient)"
                    onConfirm={(reason) => reversePayment(p, reason)}
                    onCancel={() => setRefundOpenFor(null)}
                  />
                )}
              </>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
