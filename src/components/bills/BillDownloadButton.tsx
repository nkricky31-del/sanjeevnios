import { Download } from 'lucide-react';
import { useState } from 'react';

import { downloadBillPdf, type PatientBill } from '../../lib/bills';

// Draws the bill's PDF on this device and saves it (lib/bills.ts).
export default function BillDownloadButton({
  bill,
  label = 'Download PDF',
  compact = false,
}: {
  bill: PatientBill;
  label?: string;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      await downloadBillPdf(bill);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare the PDF.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        aria-label={compact ? `Download bill ${bill.bill_no} as PDF` : undefined}
        className={`inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white font-semibold text-slate-700 outline-none hover:border-brand-300 hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60 ${
          compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm'
        }`}
      >
        <Download size={compact ? 13 : 15} aria-hidden />
        {busy ? 'Preparing…' : compact ? 'PDF' : label}
      </button>
      {error && (
        <span role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}
