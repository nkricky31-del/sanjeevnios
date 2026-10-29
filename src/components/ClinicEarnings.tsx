import Present from './ui/Present';
import { EarningsCharts } from './Insights';
import Loading from './ui/Loading';
import { Clock3, Download, IndianRupee, Printer, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { printPage, saveFile } from '../lib/native';
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

type Bucket = 'pending' | 'ready' | 'paid' | 'other';
type BucketTotals = Record<Bucket, { count: number; total: number }>;

// The list shows up to this many payments, newest first; the totals always
// cover every payment in the range, and the CSV fetches them all.
const PAGE = 1000;
const MAX_EXPORT_PAGES = 50;
const EARNINGS_COLUMNS =
  'id, appointment_id, net_amount, platform_fee, net_payout, status, hold_reason, released_at, settled_at, payout_reference, razorpay_transfer_id';

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
  // Exact totals from the database (migration 88); null until it is run, and
  // then the totals are added up from the listed rows instead.
  const [totals, setTotals] = useState<BucketTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [view, setView] = useState<'pending' | 'ready' | 'paid' | 'other'>('ready');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const loadSeq = useRef(0);

  // One page of this clinic's payments, newest first. The visit-date range
  // (yyyy-mm-dd, as the date inputs give it) is applied by the database, so
  // an older range works however many payments came after it.
  const fetchPage = (from: number, to: number) => {
    const ranged = !!(dateFrom || dateTo);
    let query = supabase
      .from('settlements')
      .select(`${EARNINGS_COLUMNS}, ${ranged ? 'appointments!inner' : 'appointments'}(date, slot_time)`)
      .eq('clinic_id', clinic.id);
    if (dateFrom) query = query.gte('appointments.date', dateFrom);
    if (dateTo) query = query.lte('appointments.date', dateTo);
    return query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to);
  };

  const load = async () => {
    const seq = ++loadSeq.current;
    // No loading flag on a refresh: what's shown stays up until the new data
    // arrives, so reopening this tab (KeepTab) or pressing Refresh never blanks it.
    const [{ data }, sums] = await Promise.all([
      fetchPage(0, PAGE - 1),
      supabase.rpc('clinic_earnings_totals', { p_clinic_id: clinic.id, p_from: dateFrom || null, p_to: dateTo || null }),
    ]);
    if (seq !== loadSeq.current) return; // a newer range was picked meanwhile
    setRows((data ?? []) as unknown as EarningsRow[]);
    if (sums.error) {
      setTotals(null);
    } else {
      const t: BucketTotals = { pending: { count: 0, total: 0 }, ready: { count: 0, total: 0 }, paid: { count: 0, total: 0 }, other: { count: 0, total: 0 } };
      for (const r of (sums.data ?? []) as { bucket: Bucket; rows_count: number; total: number | string }[]) {
        t[r.bucket] = { count: r.rows_count, total: round2(Number(r.total)) };
      }
      setTotals(t);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinic.id, dateFrom, dateTo]);

  // Already limited to the date range by the database (fetchPage).
  const filtered = rows;

  const pending = filtered.filter((r) => r.status === 'collected');
  const ready = filtered.filter((r) => r.status === 'eligible');
  const paid = filtered.filter((r) => r.status === 'released' || r.status === 'settled');
  const other = filtered.filter((r) => r.status === 'on_hold' || r.status === 'refunded');

  // "Pending" has no fee yet (still 0 in the ledger until the visit
  // completes), so its total is the raw collected amount - what it would
  // net out to isn't decided until it becomes Ready. Ready/Paid both use
  // net_amount - platform_fee, the same formula AdminSettlements.tsx uses,
  // so the two views can never quietly disagree.
  const pendingTotal = totals?.pending.total ?? round2(pending.reduce((sum, r) => sum + r.net_amount, 0));
  const readyTotal = totals?.ready.total ?? round2(ready.reduce((sum, r) => sum + (r.net_amount - r.platform_fee), 0));
  const paidTotal =
    totals?.paid.total ?? round2(paid.reduce((sum, r) => sum + (r.net_payout ?? r.net_amount - r.platform_fee), 0));
  const pendingCount = totals?.pending.count ?? pending.length;
  const readyCount = totals?.ready.count ?? ready.length;
  const paidCount = totals?.paid.count ?? paid.length;
  const otherCount = totals?.other.count ?? other.length;
  const allCount = pendingCount + readyCount + paidCount + otherCount;

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
  // Every payment in the range, fetched page by page - not just the ones
  // listed on screen.
  const downloadStatement = async () => {
    setExporting(true);
    const fetched: EarningsRow[] = [];
    for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
      const { data, error } = await fetchPage(page * PAGE, (page + 1) * PAGE - 1);
      if (error) break;
      fetched.push(...((data ?? []) as unknown as EarningsRow[]));
      if (!data || data.length < PAGE) break;
    }
    setExporting(false);
    const all = fetched.sort((a, b) => (b.appointments?.date ?? '').localeCompare(a.appointments?.date ?? ''));
    const data = csvRows(all);
    if (data.length === 0) return;
    const headers = Object.keys(data[0]);
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [headers.join(','), ...data.map((row) => headers.map((h) => escape(row[h as keyof typeof row])).join(','))].join(
      '\n'
    );
    const range = dateFrom || dateTo ? `_${dateFrom || 'start'}_to_${dateTo || 'now'}` : '';
    await saveFile(csv, `${clinic.name.replace(/\s+/g, '-')}-statement${range}.csv`, 'text/csv;charset=utf-8');
  };

  // The browser's own "Print -> Save as PDF" (the phone's print sheet in the
  // app); print:hidden below keeps the filter/action controls out of it so
  // what prints is just the statement itself.
  const printStatement = () => void printPage('Statement');

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
                <Present show={showPayout}>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                    {r.released_at && <div>{new Date(r.released_at).toLocaleDateString()}</div>}
                    {r.payout_reference && <div className="font-mono text-slate-400">{r.payout_reference}</div>}
                    {r.status === 'released' && !r.settled_at && (
                      <div className="text-amber-600">Released, not yet confirmed settled</div>
                    )}
                  </td>
                </Present>
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
        <p className="mt-3 text-sm text-slate-400"><Loading /></p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <button type="button" onClick={() => setView('pending')} className={`block rounded-2xl text-left transition ${view === 'pending' ? 'ring-2 ring-brand-500 shadow-lg' : ''}`}>
            <Card className="!p-3 text-center ">
              <Clock3 size={16} className="mx-auto text-sky-500" />
              <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Pending</p>
              <p className="mt-0.5 text-base font-extrabold text-slate-900">₹{pendingTotal.toLocaleString()}</p>
              <p className="text-[11px] text-slate-400">{pendingCount} visit(s) not yet completed</p>
            </Card>
            </button>
            <button type="button" onClick={() => setView('ready')} className={`block rounded-2xl text-left transition ${view === 'ready' ? 'ring-2 ring-brand-500 shadow-lg' : ''}`}>
            <Card className="!p-3 text-center ">
              <IndianRupee size={16} className="mx-auto text-amber-500" />
              <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Ready</p>
              <p className="mt-0.5 text-base font-extrabold text-amber-700">₹{readyTotal.toLocaleString()}</p>
              <p className="text-[11px] text-slate-400">{readyCount} awaiting release</p>
            </Card>
            </button>
            <button type="button" onClick={() => setView('paid')} className={`block rounded-2xl text-left transition ${view === 'paid' ? 'ring-2 ring-brand-500 shadow-lg' : ''}`}>
            <Card className="!p-3 text-center ">
              <Wallet size={16} className="mx-auto text-emerald-500" />
              <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Paid</p>
              <p className="mt-0.5 text-base font-extrabold text-emerald-700">₹{paidTotal.toLocaleString()}</p>
              <p className="text-[11px] text-slate-400">{paidCount} released/settled</p>
            </Card>
            </button>
          </div>

          <div className="mt-4 print:hidden"><EarningsCharts rows={filtered} /></div>

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
              <Button variant="secondary" onClick={downloadStatement} disabled={exporting}>
                <Download size={15} /> {exporting ? 'Preparing…' : 'CSV'}
              </Button>
              <Button variant="secondary" onClick={printStatement}>
                <Printer size={15} /> Print / Save PDF
              </Button>
            </div>
          </div>

          <div className="mt-4 print:hidden">
            <Segmented
              options={[
                { value: 'pending', label: `Pending (${pendingCount})` },
                { value: 'ready', label: `Ready (${readyCount})` },
                { value: 'paid', label: `Paid (${paidCount})` },
                { value: 'other', label: `Other (${otherCount})` },
              ]}
              value={view}
              onChange={setView}
              variant="scroll"
            />
          </div>

          {rows.length < allCount && (
            <p className="mt-3 text-xs text-slate-500">
              Showing the latest {rows.length.toLocaleString()} of {allCount.toLocaleString()} payments
              {dateFrom || dateTo ? ' in these dates' : ''}. The totals above include all of them, and the CSV has the
              full list.
            </p>
          )}

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
