import { FileText } from 'lucide-react';
import { useEffect, useState } from 'react';

import { DOC_LABEL, PAYMENT_LABEL, PAYMENT_TONE, rupees, type BillRow } from '../../lib/bills';
import { supabase } from '../../lib/supabaseClient';
import Card from '../ui/Card';
import IconTile from '../ui/IconTile';
import StatusPill from '../ui/StatusPill';
import BillDownloadButton from './BillDownloadButton';

// The clinic's bill for a completed visit, on the patient's appointment
// screen. Nothing shows until the clinic has completed the visit.
export default function BillCard({ appointmentId, refreshKey = 0 }: { appointmentId: string; refreshKey?: number }) {
  const [bill, setBill] = useState<BillRow | null>(null);

  useEffect(() => {
    let live = true;
    supabase
      .from('patient_bills')
      .select('*')
      .eq('appointment_id', appointmentId)
      .maybeSingle()
      .then(({ data }) => {
        if (live) setBill((data as BillRow | null) ?? null);
      });
    return () => {
      live = false;
    };
  }, [appointmentId, refreshKey]);

  if (!bill) return null;

  return (
    <Card className="mt-3">
      <div className="flex items-start gap-3">
        <IconTile icon={FileText} tone="emerald" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{DOC_LABEL[bill.doc_type]} from the clinic</p>
          <p className="mt-0.5 text-base font-bold text-slate-900">{rupees(bill.total_amount)}</p>
          <p className="text-xs text-slate-500">
            No. <span className="font-mono font-semibold text-slate-700">{bill.bill_no}</span> ·{' '}
            {bill.clinic_legal_name || bill.clinic_name}
          </p>
          <div className="mt-2">
            <StatusPill label={PAYMENT_LABEL[bill.payment_status] ?? bill.payment_status} tone={PAYMENT_TONE[bill.payment_status] ?? 'neutral'} />
          </div>
        </div>
        <BillDownloadButton bill={bill} label="Download" />
      </div>
    </Card>
  );
}
