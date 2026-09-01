import { CheckCircle2, CreditCard, Headphones, Receipt, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import AppHeader from '../components/ui/AppHeader';
import Card from '../components/ui/Card';
import IconTile from '../components/ui/IconTile';
import InfoNote from '../components/ui/InfoNote';
import SectionTitle from '../components/ui/SectionTitle';
import StatusPill from '../components/ui/StatusPill';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import { useUnreadNotifications } from '../lib/useUnreadNotifications';

interface PaymentRow {
  id: string;
  amount: number;
  method: string;
  status: string;
  created_at: string;
  appointments: {
    id: string;
    date: string;
    slot_time: string;
    doctors: { name: string; specialty: string | null } | null;
    clinics: { name: string; address: string | null } | null;
    family_members: { name: string } | null;
  } | null;
}

const STATUS_TONE: Record<string, 'live' | 'warning' | 'neutral' | 'danger'> = {
  captured: 'live',
  pending: 'warning',
  hold: 'warning',
  refunded: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  captured: 'Paid',
  pending: 'Due at clinic',
  hold: 'On hold',
  refunded: 'Refunded',
};

const rupees = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function Payments() {
  const navigate = useNavigate();
  const hasUnread = useUnreadNotifications();
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('payments')
      .select(
        'id, amount, method, status, created_at, appointments(id, date, slot_time, doctors(name, specialty), clinics(name, address), family_members(name))'
      )
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setRows((data ?? []) as unknown as PaymentRow[]);
        setLoading(false);
      });
  }, []);

  const paid = rows.filter((r) => r.status === 'captured');
  const totalPaid = paid.reduce((sum, r) => sum + Number(r.amount), 0);
  const outstanding = rows
    .filter((r) => r.status === 'pending' || r.status === 'hold')
    .reduce((sum, r) => sum + Number(r.amount), 0);

  return (
    <div>
      <AppHeader title="Bill & Payments" centered bellDot={hasUnread} onBellClick={() => navigate('/notifications')} />

      <div className="mx-auto max-w-md px-4 pb-6">
        {/* Total */}
        <Card>
          <div className="flex items-start gap-3">
            <IconTile icon={Receipt} size="md" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-slate-500">Total Paid</p>
              <p className="text-2xl font-extrabold text-slate-900">{rupees(totalPaid)}</p>
              <p className="text-xs font-semibold text-brand-600">
                {paid.length} payment{paid.length === 1 ? '' : 's'}
              </p>
            </div>
            {rows.length > 0 && outstanding === 0 && (
              <StatusPill label="All Paid" tone="live" icon={CheckCircle2} />
            )}
          </div>

          {outstanding > 0 && (
            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
              <p className="text-sm text-slate-500">Due at the clinic</p>
              <p className="text-base font-bold text-amber-600">{rupees(outstanding)}</p>
            </div>
          )}
        </Card>

        {/* History */}
        <SectionTitle className="mt-6">Payment History</SectionTitle>
        <Card className="mt-2 !p-0">
          {loading && <p className="px-4 py-5 text-sm text-slate-400">Loading...</p>}
          {!loading && rows.length === 0 && (
            <p className="px-4 py-5 text-sm text-slate-400">No payments yet.</p>
          )}
          {rows.map((r) => {
            const appt = r.appointments;
            return (
              <button
                key={r.id}
                onClick={() => appt && navigate(`/bookings/${appt.id}`)}
                className="flex w-full items-center gap-3 border-b border-slate-50 px-4 py-3.5 text-left last:border-b-0 hover:bg-slate-50"
              >
                <IconTile
                  icon={r.status === 'captured' ? CheckCircle2 : Wallet}
                  tone={r.status === 'captured' ? 'emerald' : 'amber'}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-slate-900">
                    {appt?.doctors?.name ?? 'Consultation'}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {appt
                      ? `${new Date(appt.date + 'T00:00:00').toLocaleDateString(undefined, {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        })}, ${formatTimeLabel(appt.slot_time)}`
                      : new Date(r.created_at).toLocaleDateString()}
                    {appt?.clinics?.name ? ` · ${appt.clinics.name}` : ''}
                  </span>
                  {appt?.family_members?.name && (
                    <span className="block truncate text-xs text-slate-400">For {appt.family_members.name}</span>
                  )}
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-bold text-slate-900">{rupees(Number(r.amount))}</span>
                  <StatusPill
                    label={STATUS_LABEL[r.status] ?? r.status}
                    tone={STATUS_TONE[r.status] ?? 'neutral'}
                  />
                </span>
              </button>
            );
          })}
        </Card>

        {rows.length > 0 && (
          <div className="mt-4">
            <InfoNote title="Payments in this build are a demo">
              Online payments are held/captured as records only — no real charge is made. Cash-on-visit bills are
              settled at the clinic desk.
            </InfoNote>
          </div>
        )}

        <div className="mt-4 flex items-center gap-3 rounded-2xl border border-slate-100 bg-white p-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
            <Headphones size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-900">Need help with billing?</p>
            <p className="text-xs text-slate-500">Ask the clinic desk about any charge on a visit.</p>
          </div>
          <CreditCard size={18} className="shrink-0 text-slate-300" />
        </div>
      </div>
    </div>
  );
}
