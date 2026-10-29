import { FileDown } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PAYMENT_LABEL, PAYMENT_TONE, downloadBillListPdf, fetchAllBills, rupees, type BillRow } from '../lib/bills';
import { supabase } from '../lib/supabaseClient';
import BillDownloadButton from './bills/BillDownloadButton';
import Button from './ui/Button';
import Card from './ui/Card';
import SectionTitle from './ui/SectionTitle';
import StatusPill from './ui/StatusPill';

const SHOWN = 100;

// Every bill this clinic has issued to one patient (by MRN), with a full
// statement as PDF - the clinic's record of that patient's transactions.
export default function PatientBillsSection({ clinicId, mrn }: { clinicId: string; mrn: string }) {
  const [rows, setRows] = useState<BillRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = (start: number, end: number) =>
    supabase
      .from('patient_bills')
      .select('*')
      .eq('clinic_id', clinicId)
      .eq('patient_mrn', mrn)
      .order('issued_at', { ascending: false })
      .range(start, end);

  useEffect(() => {
    let live = true;
    supabase
      .from('patient_bills')
      .select('*')
      .eq('clinic_id', clinicId)
      .eq('patient_mrn', mrn)
      .order('issued_at', { ascending: false })
      .limit(SHOWN)
      .then(({ data }) => {
        if (live) setRows((data ?? []) as BillRow[]);
      });
    return () => {
      live = false;
    };
  }, [clinicId, mrn]);

  const statement = async () => {
    setBusy(true);
    setError(null);
    try {
      const all = await fetchAllBills(query);
      if (all.length === 0) throw new Error('No bills for this patient yet.');
      const name = all[0].patient_name;
      await downloadBillListPdf({
        title: 'Statement of bills',
        subtitle: `${name} (${mrn})`,
        bills: all,
        showPatient: false,
        fileName: `statement-${mrn}.pdf`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare the statement.');
    } finally {
      setBusy(false);
    }
  };

  if (rows === null) return null;
  const billed = rows.reduce((n, b) => n + Number(b.total_amount), 0);
  const due = rows.filter((b) => b.payment_status === 'pay_at_clinic').reduce((n, b) => n + Number(b.total_amount), 0);

  return (
    <div className="mt-5">
      <SectionTitle>Bills ({rows.length}{rows.length === SHOWN ? '+' : ''})</SectionTitle>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500">No bills yet - one is issued each time this patient's visit is completed.</p>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500">
              Billed {rupees(billed)}
              {due > 0 ? ` · ${rupees(due)} due at the clinic` : ' · nothing due'}
              {rows.length === SHOWN ? ` (latest ${SHOWN})` : ''}
            </p>
            <Button variant="secondary" onClick={statement} disabled={busy}>
              <FileDown size={15} aria-hidden /> {busy ? 'Preparing…' : 'Statement PDF'}
            </Button>
          </div>
          {error && (
            <p role="alert" className="mt-1 text-sm text-red-600">
              {error}
            </p>
          )}
          <Card className="mt-2 !p-0">
            {rows.map((b) => (
              <div key={b.id} className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-xs font-semibold text-slate-800">{b.bill_no}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {new Date(b.issued_at).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}
                    {b.doctor_name ? ` · ${b.doctor_name}` : ''}
                  </span>
                </span>
                <span className="text-sm font-bold text-slate-900">{rupees(b.total_amount)}</span>
                <StatusPill label={PAYMENT_LABEL[b.payment_status] ?? b.payment_status} tone={PAYMENT_TONE[b.payment_status] ?? 'neutral'} />
                <BillDownloadButton bill={b} compact />
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
