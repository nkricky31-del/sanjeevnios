import type { BillFonts, PatientBill } from '../../supabase/functions/_shared/billPdf.ts';
import { saveFile as saveToDevice } from './native';
import { supabase } from './supabaseClient';

// Patient bills (migration 89): issued by the clinic when a visit is completed.
// The PDF is drawn by the same code the send-patient-bill edge function uses
// (supabase/functions/_shared/billPdf.ts), loaded only when someone asks for
// a PDF - it brings the PDF library and fonts with it.

export type { PatientBill };

export interface BillRow extends PatientBill {
  clinic_id: string;
  member_id: string;
  whatsapp_sent_at: string | null;
  email_sent_at: string | null;
  email_sent_to: string | null;
  last_send_error: string | null;
}

export const PAYMENT_LABEL: Record<string, string> = {
  paid_online: 'Paid online',
  paid_at_clinic: 'Paid at clinic',
  pay_at_clinic: 'Due at clinic',
  free_followup: 'Free follow-up',
  refunded: 'Refunded',
};

export const PAYMENT_TONE: Record<string, 'live' | 'warning' | 'neutral' | 'violet' | 'sky'> = {
  paid_online: 'live',
  paid_at_clinic: 'live',
  pay_at_clinic: 'warning',
  free_followup: 'sky',
  refunded: 'violet',
};

export const DOC_LABEL: Record<PatientBill['doc_type'], string> = {
  tax_invoice: 'Tax Invoice',
  bill_of_supply: 'Bill of Supply',
  invoice: 'Invoice',
};

export const rupees = (v: number | string | null | undefined) =>
  `₹${Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const loadPdfModule = () => import('../../supabase/functions/_shared/billPdf.ts');

// A TrueType/OpenType file - not, say, the website's own page served for a
// missing file.
const looksLikeFont = (b: Uint8Array) => {
  const tag = String.fromCharCode(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0);
  return (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || tag === 'true' || tag === 'OTTO' || tag === 'ttcf';
};

const fontCache = new Map<string, Promise<Uint8Array>>();
function font(file: string): Promise<Uint8Array> {
  let p = fontCache.get(file);
  if (!p) {
    p = fetch(`/fonts/${file}`).then(async (r) => {
      if (!r.ok) throw new Error(`Could not load the bill font (${r.status}).`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (!looksLikeFont(bytes)) throw new Error('Could not load the bill font - please reload the page and try again.');
      return bytes;
    });
    p.catch(() => fontCache.delete(file));
    fontCache.set(file, p);
  }
  return p;
}

async function fontsFor(texts: Array<string | null | undefined>): Promise<BillFonts> {
  const pdf = await loadPdfModule();
  const deva = pdf.needsDevanagari(texts);
  const f = pdf.BILL_FONT_FILES;
  const [regular, bold, devanagari, devanagariBold] = await Promise.all([
    font(f.regular),
    font(f.bold),
    deva ? font(f.devanagari) : Promise.resolve(undefined),
    deva ? font(f.devanagariBold) : Promise.resolve(undefined),
  ]);
  return { regular, bold, devanagari, devanagariBold };
}

// A download on the website; the share sheet (Files, Drive, WhatsApp...) in the app.
function saveFile(bytes: Uint8Array, name: string, type = 'application/pdf'): Promise<void> {
  return saveToDevice(bytes, name, type);
}

export function billFileName(bill: Pick<PatientBill, 'doc_type' | 'bill_no'>): string {
  return `${DOC_LABEL[bill.doc_type].replace(/\s+/g, '-')}-${bill.bill_no.replace(/\//g, '-')}.pdf`;
}

export async function downloadBillPdf(bill: PatientBill): Promise<void> {
  const pdf = await loadPdfModule();
  const bytes = await pdf.renderBillPdf(bill, await fontsFor(pdf.billTextFields(bill)));
  await saveFile(bytes, billFileName(bill));
}

// A clinic's statement for one patient, or its register for a date range.
export async function downloadBillListPdf(opts: {
  title: string;
  subtitle: string;
  bills: PatientBill[];
  showPatient: boolean;
  fileName: string;
}): Promise<void> {
  const pdf = await loadPdfModule();
  const latest = opts.bills[0];
  const clinic = latest ?? null;
  if (!clinic) throw new Error('There are no bills to put in the PDF.');
  const texts = opts.bills.flatMap((b) => [b.patient_name, b.doctor_name]).concat(pdf.billTextFields(clinic));
  const bytes = await pdf.renderBillListPdf(
    {
      title: opts.title,
      subtitle: opts.subtitle,
      clinic,
      bills: opts.bills,
      showPatient: opts.showPatient,
      generatedAt: new Date().toISOString(),
    },
    await fontsFor(texts)
  );
  await saveFile(bytes, opts.fileName);
}

export async function downloadBillsCsv(bills: PatientBill[], fileName: string): Promise<void> {
  const header = ['Bill no', 'Type', 'Bill date', 'Patient', 'MRN', 'Doctor', 'Visit date', 'Fee', 'Discount', 'Taxable value', 'CGST', 'SGST', 'Total', 'Payment', 'Paid amount', 'Payment ref'];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const day = (ts: string) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const lines = bills.map((b) =>
    [
      b.bill_no, DOC_LABEL[b.doc_type], day(b.issued_at), b.patient_name, b.patient_mrn, b.doctor_name, b.visit_date,
      b.fee_amount, b.discount_amount, b.taxable_value, b.cgst_amount, b.sgst_amount, b.total_amount,
      PAYMENT_LABEL[b.payment_status] ?? b.payment_status, b.paid_amount, b.payment_reference,
    ].map(esc).join(',')
  );
  await saveFile(new TextEncoder().encode([header.join(','), ...lines].join('\n')), fileName, 'text/csv;charset=utf-8');
}

export type SendResult = { whatsapp: string; email: string } | { error: string };

// Asks the server to WhatsApp / email the bill to its patient. Best-effort:
// channels that aren't set up come back as "skipped".
export async function sendPatientBill(args: { billId?: string; appointmentId?: string }): Promise<SendResult> {
  const { data, error } = await supabase.functions.invoke('send-patient-bill', { body: args });
  if (error) return { error: error.message };
  return data as SendResult;
}

export function describeSend(r: SendResult): string {
  if ('error' in r) {
    // The sending service unreachable (not deployed yet, or no internet).
    if (/Failed to send a request|Failed to fetch|NetworkError/i.test(r.error)) {
      return "Couldn't reach the sending service - the bill is still in the patient's app.";
    }
    return `Could not send: ${r.error}`;
  }
  const part = (name: string, v: string) =>
    v === 'sent'
      ? `${name}: sent`
      : v === 'skipped:no_phone'
        ? `${name}: no phone number on file`
        : v === 'skipped:no_email'
          ? `${name}: no email on file`
          : v === 'skipped:not_configured'
            ? `${name}: not set up yet`
            : v === 'skipped:just_sent'
              ? `${name}: sent a moment ago`
              : `${name}: failed`;
  return `${part('WhatsApp', r.whatsapp)} · ${part('Email', r.email)}`;
}

// The whole of a clinic's bills for a range, page by page (for PDFs/CSV).
export async function fetchAllBills(
  build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  pageSize = 1000,
  maxPages = 50
): Promise<BillRow[]> {
  const all: BillRow[] = [];
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await build(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as BillRow[]));
    if (!data || data.length < pageSize) break;
  }
  return all;
}
