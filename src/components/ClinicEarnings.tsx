import { Clock3, Download, IndianRupee, Printer, Wallet } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { bookingReference } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import type { Clinic, SettlementStatus } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import Segmented from './ui/Segmented';

interface Props {
  clinic: Clinic;
}

interface EarningsRow {
  id: string;
  appointment_id: string;
  net_amount: number;
  platform_fee: number;
  net_payout: number | null;
  status: SettlementStatus;
  hold_reason: string | null;
  released_at: string | null;
  settled_at: string | null;
  payout_reference: string | null;
  razorpay_transfer_id: string | null;
  appointments: { date: string; slot_time: string } | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// The clinic-side view of migration 59's settlement ledger - same table,
// same RLS (settlements_select already reads `is_admin() or
// is_own_clinic(clinic_id)`, so a clinic reading its own rows here needs no
// new access at all), just grouped into the three totals a clinic actually
// cares about instead of the admin's release workflow. Read-only by design:
// releasing, holding, and settling a payout are admin-only actions
// (AdminSettlements.tsx) - this page can only ever show what's already
// true, which is exactly what keeps the two views honest with each other.
export default function ClinicEarnings({ clinic }: Props) {
  const [rows, setRows] = useState<EarningsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'pending' | 'ready' | 'paid' | 'other'>('ready');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('settlements')
      .select(
        'id, appointment_id, net_amount, platform_fee, net_payout, status, hold_reason, released_at, settled_at, payout_reference, razorpay_transfer_id, appointments(date, slot_time)'
      )
      .eq('clinic_id', clinic.id)
      .order('created_at', { ascending: false })
      .limit(1000);
    setRows((data ?? []) as unknown as EarningsRow[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinic.id]);

  // Same date-range box the filter inputs use natively (yyyy-mm-dd) -
  // appointments.date already comes back in that exact form, so this is a
  // plain string comparison, not a date parse.
  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        const date = r.appointments?.date;
        if (dateFrom && (!date || date < dateFrom)) return false;
        if (dateTo && (!date || date > dateTo)) return false;
        return true;
      }),
    [rows, dateFrom, dateTo]
  );

  const pending = filtered.filter((r) => r.status === 'collected');
  const ready = filtered.filter((r) => r.status === 'eligible');
  const paid = filtered.filter((r) => r.status === 'released' || r.status === 'settled');
  const other = filtered.filter((r) => r.status === 'on_hold' || r.status === 'refunded');

  // "Pending" has no fee yet (still 0 in the ledger until the visit
  // completes), so its total is the raw collected amount - what it would
  // net out to isn't decided until it becomes Ready. Ready/Paid both use
  // net_amount - platform_fee, the same formula AdminSettlements.tsx uses,
  // so the two views can never quietly disagree.
  const pendingTotal = round2(pending.reduce((sum, r) => sum + r.net_amount, 0));
  const readyTotal = round2(ready.reduce((sum, r) => sum + (r.net_amount - r.platform_fee), 0));
  const paidTotal = round2(paid.reduce((sum, r) => sum + (r.net_payout ?? r.net_amount - r.platform_fee), 0));

  const visitLabel = (r: EarningsRow) =>
    r.appointments ? `${r.appointments.date} at ${r.appointments.slot_time?.slice(0, 5)}` : '—';

  const csvRows = (list: EarningsRow[]) =>
    list.map((r) => ({
      'Booking ref': bookingReference(r.appointment_id),
      'Visit date': r.appointments?.date ?? '',
      Status: r.status,
      'Amount collected': r.net_amount.toFixed(2),
      'Platform fee': r.platform_fee.toFixed(2),
      'Net payable': round2((r.net_payout ?? r.net_amount - r.platform_fee)).toFixed(2),
      'Payout date': r.released_at ? new Date(r.released_at).toLocaleDateString() : '',
      'Payout reference': r.payout_reference ?? '',
    }));

  // A plain client-side CSV, no library needed - Excel/Sheets/every
  // accounting tool a clinic is likely to already use opens this directly.
  const downloadStatement = () => {
    const all = [...pending, ...ready, ...paid, ...other].sort((a, b) =>
      (b.appointments?.date ?? '').localeCompare(a.appointments?.date ?? '')
    );
    const data = csvRows(all);
    if (data.length === 0) return;
    const headers = Object.keys(data[0]);
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [headers.join(','), ...data.map((row) => headers.map((h) => escape(row[h as keyof typeof row])).join(','))].join(
      '\n'
    );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const range = dateFrom || dateTo ? `_${dateFrom || 'start'}_to_${dateTo || 'now'}` : '';
    a.href = url;
    a.download = `${clinic.name.replace(/\s+/g, '-')}-statement${range}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // No PDF library in this project yet - the browser's own "Print -> Save as
  // PDF" is a zero-dependency way to get the same result, and print:hidden
  // below keeps the filter/action controls out of it so what prints is just
  // the statement itself.
  const printStatement = () => window.print();

  const table = (list: EarningsRow[], emptyLabel: string, showPayout: boolean) => (
    <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-100">
      {list.length === 0 ? (
        <p className="p-4 text-sm text-slate-400">{emptyLabel}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-3 py-2">Booking ref</th>
              <th className="px-3 py-2">Visit date</th>
              <th className="px-3 py-2 text-right">Collected</th>
              <th className="px-3 py-2 text-right">Platform fee</th>
              <th className="px-3 py-2 text-right">Net payable</th>
              {showPayout && <th className="px-3 py-2">Payout</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {list.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-700">
                  {bookingReference(r.appointment_id)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">{visitLabel(r)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-slate-700">
                  ₹{r.net_amount.toLocaleString()}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-slate-500">
                  ₹{r.platform_fee.toLocaleString()}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-bold text-emerald-700">
                  ₹{round2(r.net_payout ?? r.net_amount - r.platform_fee).toLocaleString()}
                </td>
                {showPayout && (
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                    {r.released_at && <div>{new Date(r.released_at).toLocaleDateString()}</div>}
                    {r.payout_reference && <div className="font-mono text-slate-400">{r.payout_reference}</div>}
                    {r.status === 'released' && !r.settled_at && (
                      <div className="text-amber-600">Released, not yet confirmed settled</div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between print:hidden">
        <h2 className="text-lg font-bold text-slate-900">Earnings</h2>
        <button onClick={load} className="text-sm font-medium text-brand-600">
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400 print:hidden">
        What SanjeevniOS has collected from patients on your behalf, and where each payment currently stands. Booking
        references only - patient details stay in your own queue and records.
      </p>

      <p className="mt-4 hidden text-lg font-bold text-slate-900 print:block">{clinic.name} - Earnings statement</p>
      {(dateFrom || dateTo) && (
        <p className="hidden text-sm text-slate-500 print:block">
          {dateFrom || 'Start'} to {dateTo || 'today'}
        </p>
      )}

      {loading ? (
        <p className="mt-3 text-sm text-slate-400">Loading...</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Card className="!p-3 text-center">
              <Clock3 size={16} className="mx-auto text-slate-400" />
              <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Pending</p>
              <p className="mt-0.5 text-base font-extrabold text-slate-900">₹{pendingTotal.toLocaleString()}</p>
              <p className="text-[11px] text-slate-400">{pending.length} visit(s) not yet completed</p>
            </Card>
            <Card className="!p-3 text-center">
              <IndianRupee size={16} className="mx-auto text-amber-500" />
              <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Ready</p>
              <p className="mt-0.5 text-base font-extrabold text-amber-700">₹{readyTotal.toLocaleString()}</p>
              <p className="text-[11px] text-slate-400">{ready.length} awaiting release</p>
            </Card>
            <Card className="!p-3 text-center">
              <Wallet size={16} className="mx-auto text-emerald-500" />
              <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Paid</p>
              <p className="mt-0.5 text-base font-extrabold text-emerald-700">₹{paidTotal.toLocaleString()}</p>
              <p className="text-[11px] text-slate-400">{paid.length} released/settled</p>
            </Card>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-2 print:hidden">
            <div>
              <label className="text-xs font-bold text-slate-700">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="mt-1 block rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="mt-1 block rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            {(dateFrom || dateTo) && (
              <button
                onClick={() => {
                  setDateFrom('');
                  setDateTo('');
                }}
                className="pb-2 text-xs font-semibold text-slate-400 underline"
              >
                Clear
              </button>
            )}
            <div className="ml-auto flex gap-2">
              <Button variant="secondary" onClick={downloadStatement}>
                <Download size={15} /> CSV
              </Button>
              <Button variant="secondary" onClick={printStatement}>
                <Printer size={15} /> Print / Save PDF
              </Button>
            </div>
          </div>

          <div className="mt-4 print:hidden">
            <Segmented
              options={[
                { value: 'pending', label: `Pending (${pending.length})` },
                { value: 'ready', label: `Ready (${ready.length})` },
                { value: 'paid', label: `Paid (${paid.length})` },
                { value: 'other', label: `Other (${other.length})` },
              ]}
              value={view}
              onChange={setView}
              variant="scroll"
            />
          </div>

          {/* Screen: whichever tab is selected. Print: every non-empty
              section, one after another, labelled - a statement should
              read top to bottom, not hide behind tabs. */}
          <div className="print:hidden">
            {view === 'pending' && table(pending, 'Nothing collected and awaiting visit completion.', false)}
            {view === 'ready' && table(ready, 'Nothing ready for release right now.', false)}
            {view === 'paid' && table(paid, 'Nothing paid out yet.', true)}
            {view === 'other' && (
              <div className="mt-3 space-y-2">
                {other.length === 0 && <p className="text-sm text-slate-400">Nothing on hold or refunded.</p>}
                {other.map((r) => (
                  <Card key={r.id}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-mono text-xs text-slate-700">{bookingReference(r.appointment_id)}</p>
                      <p className="text-xs font-bold uppercase text-slate-500">{r.status.replace('_', ' ')}</p>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">{visitLabel(r)}</p>
                    {r.hold_reason && <p className="mt-1 text-xs text-amber-700">{r.hold_reason}</p>}
                  </Card>
                ))}
              </div>
            )}
          </div>

          <div className="hidden print:block">
            <p className="mt-4 font-bold text-slate-900">Pending</p>
            {table(pending, 'None.', false)}
            <p className="mt-4 font-bold text-slate-900">Ready</p>
            {table(ready, 'None.', false)}
            <p className="mt-4 font-bold text-slate-900">Paid</p>
            {table(paid, 'None.', true)}
          </div>
        </>
      )}
    </div>
  );
}
