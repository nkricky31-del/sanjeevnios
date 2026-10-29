import { FileDown, FileSpreadsheet, Mail, MessageCircle, Search, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DOC_LABEL,
  PAYMENT_LABEL,
  PAYMENT_TONE,
  describeSend,
  downloadBillListPdf,
  downloadBillsCsv,
  fetchAllBills,
  rupees,
  sendPatientBill,
  type BillRow,
} from '../lib/bills';
import { todayISO } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import BillDownloadButton from './bills/BillDownloadButton';
import Button from './ui/Button';
import StatusPill from './ui/StatusPill';

const PAGE = 50;

interface Totals {
  bills: number;
  billed: number;
  paid: number;
  due: number;
  refunded: number;
}

const monthStart = () => `${todayISO().slice(0, 8)}01`;
const nextDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
// Bill dates are the clinic's calendar days (India).
const dayStart = (iso: string) => `${iso}T00:00:00+05:30`;
const billDay = (ts: string) =>
  new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const visitDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
// Characters that would break a PostgREST or() filter are dropped.
const cleanSearch = (q: string) => q.replace(/[,()%*\\]/g, ' ').trim();

// The clinic's Patient bills tab (migration 89): every bill issued for a
// completed visit - find, re-download, re-send, and download the lot for a
// date range as a register (PDF) or CSV.
export default function ClinicBills({ clinicId }: { clinicId: string }) {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<BillRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [unbilled, setUnbilled] = useState(0);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState<'pdf' | 'csv' | null>(null);
  const [sendNote, setSendNote] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const seq = useRef(0);

  // Debounced search box.
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(cleanSearch(query)), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const page = useCallback(
    (start: number, end: number) => {
      let q = supabase
        .from('patient_bills')
        .select('*')
        .eq('clinic_id', clinicId)
        .gte('issued_at', dayStart(from))
        .lt('issued_at', dayStart(nextDay(to)));
      if (search) q = q.or(`patient_name.ilike.%${search}%,patient_mrn.ilike.%${search}%,bill_no.ilike.%${search}%`);
      return q.order('issued_at', { ascending: false }).order('bill_no', { ascending: false }).range(start, end);
    },
    [clinicId, from, to, search]
  );

  const load = useCallback(async () => {
    const mine = ++seq.current;
    // No loading flag on a refresh: what's shown stays up until the new data
    // arrives, so reopening this tab (KeepTab) or pressing Refresh never blanks it.
    setError(null);
    const [list, sums, missing] = await Promise.all([
      page(0, PAGE - 1),
      supabase.rpc('clinic_bill_totals', { p_clinic_id: clinicId, p_from: from, p_to: to }),
      supabase.rpc('count_unbilled_visits', { p_clinic_id: clinicId, p_from: from, p_to: to }),
    ]);
    if (mine !== seq.current) return;
    if (list.error) setError(list.error.message);
    const data = (list.data ?? []) as BillRow[];
    setRows(data);
    setHasMore(data.length === PAGE);
    const t = ((sums.data ?? []) as Totals[])[0];
    setTotals(t ? { bills: t.bills, billed: Number(t.billed), paid: Number(t.paid), due: Number(t.due), refunded: Number(t.refunded) } : null);
    setUnbilled(typeof missing.data === 'number' ? missing.data : 0);
    setLoading(false);
  }, [clinicId, from, to, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    const { data, error: moreError } = await page(rows.length, rows.length + PAGE - 1);
    if (moreError) {
      setError(moreError.message);
      return;
    }
    const more = (data ?? []) as BillRow[];
    setRows((prev) => [...prev, ...more]);
    setHasMore(more.length === PAGE);
  };

  const createMissing = async () => {
    setCreating(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('issue_missing_patient_bills', { p_clinic_id: clinicId, p_from: from, p_to: to });
    setCreating(false);
    if (rpcError) setError(rpcError.message);
    void load();
  };

  const send = async (bill: BillRow) => {
    setSending(bill.id);
    const result = await sendPatientBill({ billId: bill.id });
    setSending(null);
    setSendNote((prev) => ({ ...prev, [bill.id]: describeSend(result) }));
    void load();
  };

  const rangeLabel = `${visitDay(from)} to ${visitDay(to)}`;
  const fileBase = `bills-${from}-to-${to}`;
  const exportAll = async (kind: 'pdf' | 'csv') => {
    setExporting(kind);
    setError(null);
    try {
      const all = await fetchAllBills((start, end) => page(start, end));
      if (all.length === 0) throw new Error('There are no bills in these dates.');
      if (kind === 'csv') await downloadBillsCsv(all, `${fileBase}.csv`);
      else
        await downloadBillListPdf({
          title: 'Bills register',
          subtitle: search ? `${rangeLabel} · "${search}"` : rangeLabel,
          bills: all,
          showPatient: true,
          fileName: `${fileBase}.pdf`,
        });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare the download.');
    } finally {
      setExporting(null);
    }
  };

  return (
    <div>
      <h2 className="text-lg font-bold text-slate-900">Patient bills</h2>
      <p className="mt-0.5 text-xs text-slate-400">
        A bill in your clinic's name is issued for every completed visit. Find one, download it, send it again, or
        download all of them for a period.
      </p>

      <div className="mt-3 grid gap-3 rounded-2xl border border-slate-200 bg-white p-3 sm:grid-cols-[1fr_auto_auto]">
        <label className="flex items-center rounded-xl border border-slate-200 bg-white px-3 focus-within:ring-2 focus-within:ring-brand-500">
          <Search size={16} className="shrink-0 text-slate-400" aria-hidden />
          <span className="sr-only">Search bills</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Patient name, MRN or bill no."
            className="w-full bg-transparent px-2 py-2.5 text-sm outline-none placeholder:text-slate-400"
          />
        </label>
        <label className="text-xs font-bold text-slate-700">
          From
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
            className="mt-1 block rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm font-normal outline-none focus:ring-2 focus:ring-brand-500"
          />
        </label>
        <label className="text-xs font-bold text-slate-700">
          To
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => e.target.value && setTo(e.target.value)}
            className="mt-1 block rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm font-normal outline-none focus:ring-2 focus:ring-brand-500"
          />
        </label>
      </div>

      {/* Totals for the dates, from the database */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Bills', totals ? String(totals.bills) : '—'],
          ['Billed', totals ? rupees(totals.billed) : '—'],
          ['Paid', totals ? rupees(totals.paid) : '—'],
          ['Due at clinic', totals ? rupees(totals.due) : '—'],
        ].map(([k, v]) => (
          <div key={k} className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{k}</p>
            <p className={`mt-0.5 text-base font-extrabold ${k === 'Due at clinic' && totals && totals.due > 0 ? 'text-amber-700' : 'text-slate-900'}`}>{v}</p>
          </div>
        ))}
      </div>

      {unbilled > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-2.5">
          <p className="text-sm text-amber-900">
            {unbilled} completed visit{unbilled === 1 ? '' : 's'} in these dates {unbilled === 1 ? 'has' : 'have'} no bill yet.
          </p>
          <Button variant="secondary" onClick={createMissing} disabled={creating}>
            {creating ? 'Creating…' : `Create ${unbilled === 1 ? 'the bill' : 'bills'}`}
          </Button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {search ? `Bills matching "${search}"` : 'All bills'} · {rangeLabel}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => exportAll('pdf')} disabled={!!exporting || rows.length === 0}>
            <FileDown size={15} aria-hidden /> {exporting === 'pdf' ? 'Preparing…' : 'Register PDF'}
          </Button>
          <Button variant="secondary" onClick={() => exportAll('csv')} disabled={!!exporting || rows.length === 0}>
            <FileSpreadsheet size={15} aria-hidden /> {exporting === 'csv' ? 'Preparing…' : 'CSV'}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-2 overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {/* relative: screen-reader-only labels in the cells are positioned,
            and must be clipped by this scroll box, not widen the page */}
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-2.5 font-semibold uppercase tracking-wide">Bill</th>
                <th scope="col" className="px-3 py-2.5 font-semibold uppercase tracking-wide">Patient</th>
                <th scope="col" className="px-3 py-2.5 font-semibold uppercase tracking-wide">Doctor</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">Amount</th>
                <th scope="col" className="px-3 py-2.5 font-semibold uppercase tracking-wide">Payment</th>
                <th scope="col" className="px-3 py-2.5 font-semibold uppercase tracking-wide">Sent</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 4 }, (_, i) => (
                  <tr key={i} aria-hidden className="border-t border-slate-100">
                    {Array.from({ length: 7 }, (_, c) => (
                      <td key={c} className="px-3 py-3">
                        <span className="block h-3.5 w-24 animate-pulse rounded bg-slate-100" />
                      </td>
                    ))}
                  </tr>
                ))}
              {!loading && rows.length === 0 && (
                <tr className="border-t border-slate-100">
                  <td colSpan={7} className="px-3 py-10 text-center text-sm text-slate-500">
                    {search ? 'No bills match this search in these dates.' : 'No bills in these dates yet. Bills appear here as visits are completed.'}
                  </td>
                </tr>
              )}
              {!loading &&
                rows.map((b) => (
                  <tr key={b.id} className="border-t border-slate-100 align-top">
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <p className="font-mono text-xs font-semibold text-slate-800">{b.bill_no}</p>
                      <p className="text-xs text-slate-500">{billDay(b.issued_at)} · {DOC_LABEL[b.doc_type]}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-slate-900">{b.patient_name}</p>
                      <p className="text-xs text-slate-500">{b.patient_mrn ?? '—'}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="text-slate-800">{b.doctor_name ?? '—'}</p>
                      <p className="text-xs text-slate-500">Visit {visitDay(b.visit_date)}</p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold text-slate-900">{rupees(b.total_amount)}</td>
                    <td className="px-3 py-2.5">
                      <StatusPill label={PAYMENT_LABEL[b.payment_status] ?? b.payment_status} tone={PAYMENT_TONE[b.payment_status] ?? 'neutral'} />
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2 text-xs">
                        <span
                          className={`inline-flex items-center gap-1 ${b.whatsapp_sent_at ? 'text-emerald-700' : 'text-slate-400'}`}
                          title={b.whatsapp_sent_at ? `WhatsApp sent ${billDay(b.whatsapp_sent_at)}` : 'Not sent on WhatsApp'}
                        >
                          <MessageCircle size={13} aria-hidden />
                          <span className="sr-only">WhatsApp:</span> {b.whatsapp_sent_at ? 'Yes' : 'No'}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 ${b.email_sent_at ? 'text-emerald-700' : 'text-slate-400'}`}
                          title={b.email_sent_at ? `Emailed to ${b.email_sent_to ?? ''}` : 'Not emailed'}
                        >
                          <Mail size={13} aria-hidden />
                          <span className="sr-only">Email:</span> {b.email_sent_at ? 'Yes' : 'No'}
                        </span>
                      </span>
                      {sendNote[b.id] && <p className="mt-1 max-w-[220px] text-[11px] text-slate-500">{sendNote[b.id]}</p>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <span className="inline-flex items-start gap-1.5">
                        <BillDownloadButton bill={b} compact />
                        <button
                          type="button"
                          onClick={() => send(b)}
                          disabled={sending === b.id}
                          aria-label={`Send bill ${b.bill_no} to ${b.patient_name}`}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:border-brand-300 hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60"
                        >
                          <Send size={13} aria-hidden /> {sending === b.id ? 'Sending…' : 'Send'}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!loading && hasMore && (
          <div className="border-t border-slate-100 p-2 text-center">
            <button type="button" onClick={loadMore} className="rounded-xl px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50">
              Show more bills
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
