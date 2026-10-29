// supabase/functions/_shared/billPdf.ts
//
// The one place a patient bill's PDF is drawn - used by the app (download in
// the patient app and the clinic console) and by the send-patient-bill edge
// function (WhatsApp / email), so every copy looks the same. Pure TypeScript
// on pdf-lib: no browser or Deno APIs. The caller passes the font files
// (public/fonts/ - Noto Sans, with the rupee sign, and Noto Sans Devanagari
// for names written in Hindi).
//
// The bill is issued by the CLINIC (migration 89): its name, address, GSTIN,
// a running number per financial year. Document title by GST status:
//   no GSTIN              -> "Invoice"
//   GSTIN, exempt (0%)    -> "Bill of Supply" (health care is GST-exempt)
//   GSTIN, GST charged    -> "Tax Invoice", with CGST + SGST shown
// Both must load before fontkit: Deno lacks the __proto__ accessor fontkit's
// classes rely on (protoShim.ts), and its shaping for Indic scripts
// (Devanagari names) expects Babel's global generator helper.
import './protoShim.ts';
import 'regenerator-runtime/runtime.js';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import { gstState } from './gst.ts';

export { gstState, isValidGstin } from './gst.ts';

export interface PatientBill {
  id: string;
  appointment_id: string;
  bill_no: string;
  doc_type: 'tax_invoice' | 'bill_of_supply' | 'invoice';
  issued_at: string;
  clinic_name: string;
  clinic_legal_name: string | null;
  clinic_address: string | null;
  clinic_phone: string | null;
  clinic_email: string | null;
  clinic_reg_no: string | null;
  clinic_gstin: string | null;
  patient_name: string;
  patient_mrn: string | null;
  patient_phone: string | null;
  doctor_name: string | null;
  doctor_specialty: string | null;
  doctor_reg_no: string | null;
  visit_date: string;
  visit_time: string | null;
  sac_code: string;
  description: string;
  fee_amount: number | string;
  discount_amount: number | string;
  discount_label: string | null;
  total_amount: number | string;
  gst_rate: number | string;
  taxable_value: number | string;
  cgst_amount: number | string;
  sgst_amount: number | string;
  payment_status: string;
  payment_method: string | null;
  paid_amount: number | string | null;
  convenience_fee: number | string;
  paid_at: string | null;
  payment_reference: string | null;
}

export interface BillFonts {
  regular: Uint8Array;
  bold: Uint8Array;
  // Needed only when some text is in Devanagari (needsDevanagari()).
  devanagari?: Uint8Array;
  devanagariBold?: Uint8Array;
}

// File names under the site's /fonts/ folder.
export const BILL_FONT_FILES = {
  regular: 'NotoSans-Regular.ttf',
  bold: 'NotoSans-Bold.ttf',
  devanagari: 'NotoSansDevanagari-Regular.ttf',
  devanagariBold: 'NotoSansDevanagari-Bold.ttf',
} as const;

const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ]/;
const DEVANAGARI_RUN_CHAR = /[ऀ-ॿ꣠-ꣿ‌‍]/;

export function needsDevanagari(values: Array<string | null | undefined>): boolean {
  return values.some((v) => !!v && DEVANAGARI.test(v));
}

export function billTextFields(b: PatientBill): Array<string | null> {
  return [b.patient_name, b.clinic_name, b.clinic_legal_name, b.clinic_address, b.doctor_name, b.doctor_specialty, b.description, b.discount_label];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const num = (v: number | string | null | undefined): number => (v == null || v === '' ? 0 : Number(v));

// 1234567.5 -> "12,34,567.50" (Indian grouping)
export function formatINR(value: number | string | null | undefined): string {
  const n = num(value);
  const sign = n < 0 ? '-' : '';
  const [int, frac] = Math.abs(n).toFixed(2).split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return `${sign}${grouped}.${frac}`;
}
const rupees = (v: number | string | null | undefined) => `₹${formatINR(v)}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM-DD' -> '29 Oct 2026' (no time zone involved)
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

// A moment, as the date in India (bills are issued in IST).
export function formatMomentIST(ts: string | null | undefined): string {
  if (!ts) return '';
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return '';
  const ist = new Date(t.getTime() + 330 * 60_000);
  return `${String(ist.getUTCDate()).padStart(2, '0')} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

// '14:05:00' -> '2:05 PM'
export function formatClock(time: string | null | undefined): string {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

// '919876543210' -> '+91 98765 43210'
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  if (ten.length !== 10) return phone;
  return `+91 ${ten.slice(0, 5)} ${ten.slice(5)}`;
}

export function bookingRef(appointmentId: string): string {
  return appointmentId.slice(0, 8).toUpperCase();
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}
function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? ONES[h] + ' Hundred' : '', r ? belowHundred(r) : ''].filter(Boolean).join(' ');
}
// Indian system: crore, lakh, thousand.
function wordsIndian(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(wordsIndian(crore) + ' Crore');
  if (lakh) parts.push(belowHundred(lakh) + ' Lakh');
  if (thousand) parts.push(belowHundred(thousand) + ' Thousand');
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}

// 410.5 -> "Rupees Four Hundred Ten and Fifty Paise Only"
export function rupeesInWords(value: number | string | null | undefined): string {
  const paiseTotal = Math.round(Math.abs(num(value)) * 100);
  const r = Math.floor(paiseTotal / 100);
  const p = paiseTotal % 100;
  return `Rupees ${wordsIndian(r)}${p ? ` and ${belowHundred(p)} Paise` : ''} Only`;
}

export const DOC_TITLE: Record<PatientBill['doc_type'], string> = {
  tax_invoice: 'Tax Invoice',
  bill_of_supply: 'Bill of Supply',
  invoice: 'Invoice',
};

export function paymentLine(b: PatientBill): string {
  const when = b.paid_at ? ` on ${formatMomentIST(b.paid_at)}` : '';
  switch (b.payment_status) {
    case 'paid_online': {
      const ref = b.payment_reference ? ` (Razorpay ref ${b.payment_reference})` : '';
      const fee = num(b.convenience_fee) > 0
        ? ` This includes the ${rupees(b.convenience_fee)} SanjeevniOS online convenience fee, which is not part of this bill.`
        : '';
      return `Paid online ${rupees(b.paid_amount ?? b.total_amount)}${when}${ref}.${fee}`;
    }
    case 'paid_at_clinic':
      return `Paid at the clinic ${rupees(b.paid_amount ?? b.total_amount)}${when}.`;
    case 'free_followup':
      return 'Free follow-up - nothing to pay.';
    case 'refunded':
      return `Refunded${b.paid_amount != null ? ` ${rupees(b.paid_amount)}` : ''}.`;
    default:
      return num(b.total_amount) > 0 ? `To be paid at the clinic: ${rupees(b.total_amount)}.` : 'Nothing to pay.';
  }
}

export const PAYMENT_SHORT: Record<string, string> = {
  paid_online: 'Paid online',
  paid_at_clinic: 'Paid at clinic',
  pay_at_clinic: 'Due',
  free_followup: 'Free follow-up',
  refunded: 'Refunded',
};

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const A4: [number, number] = [595.28, 841.89];
const MARGIN = 40;
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.89, 0.91, 0.94);
const SOFT = rgb(0.95, 0.96, 0.98);
const ACCENT = rgb(0.23, 0.36, 0.86);

interface Fontset {
  regular: PDFFont;
  bold: PDFFont;
  deva: PDFFont | null;
  devaBold: PDFFont | null;
}

async function embedFonts(doc: PDFDocument, fonts: BillFonts): Promise<Fontset> {
  doc.registerFontkit(fontkit);
  const [regular, bold, deva, devaBold] = await Promise.all([
    doc.embedFont(fonts.regular, { subset: true }),
    doc.embedFont(fonts.bold, { subset: true }),
    fonts.devanagari ? doc.embedFont(fonts.devanagari, { subset: true }) : Promise.resolve(null),
    fonts.devanagariBold ? doc.embedFont(fonts.devanagariBold, { subset: true }) : Promise.resolve(null),
  ]);
  return { regular, bold, deva, devaBold };
}

interface Run {
  text: string;
  font: PDFFont;
}

class Writer {
  private f: Fontset;
  private latinChars: Set<number>;
  private latinBoldChars: Set<number>;

  constructor(f: Fontset) {
    this.f = f;
    this.latinChars = new Set(f.regular.getCharacterSet());
    this.latinBoldChars = new Set(f.bold.getCharacterSet());
  }

  // Splits text into Latin and Devanagari pieces, each with a font that has
  // its letters; anything neither font has becomes '?'.
  runs(text: string, bold: boolean): Run[] {
    const latin = bold ? this.f.bold : this.f.regular;
    const latinSet = bold ? this.latinBoldChars : this.latinChars;
    const deva = bold ? this.f.devaBold ?? this.f.deva : this.f.deva;
    const out: Run[] = [];
    let buf = '';
    let bufDeva = false;
    const flush = () => {
      if (buf) out.push({ text: buf, font: bufDeva && deva ? deva : latin });
      buf = '';
    };
    for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
      const isDeva = DEVANAGARI_RUN_CHAR.test(ch) && !!deva;
      // A space between two Devanagari words stays with them.
      const joinsCurrent = ch === ' ' && bufDeva;
      if (!joinsCurrent && isDeva !== bufDeva) {
        flush();
        bufDeva = isDeva;
      }
      const code = ch.codePointAt(0) ?? 63;
      buf += isDeva || joinsCurrent || latinSet.has(code) ? ch : '?';
    }
    flush();
    return out;
  }

  width(text: string, size: number, bold = false): number {
    return this.runs(text, bold).reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, size), 0);
  }

  draw(
    page: PDFPage,
    text: string,
    x: number,
    y: number,
    opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; align?: 'left' | 'right' | 'center' } = {}
  ): void {
    const size = opts.size ?? 10;
    const bold = opts.bold ?? false;
    const runs = this.runs(text, bold);
    const total = runs.reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, size), 0);
    let cx = opts.align === 'right' ? x - total : opts.align === 'center' ? x - total / 2 : x;
    for (const r of runs) {
      page.drawText(r.text, { x: cx, y, size, font: r.font, color: opts.color ?? INK });
      cx += r.font.widthOfTextAtSize(r.text, size);
    }
  }

  // Word-wraps to maxWidth; very long words are broken up.
  wrap(text: string, maxWidth: number, size: number, bold = false): string[] {
    const words = text.replace(/\s+/g, ' ').trim().split(' ');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (this.width(candidate, size, bold) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (this.width(word, size, bold) <= maxWidth) {
        line = word;
        continue;
      }
      let piece = '';
      for (const ch of word) {
        if (this.width(piece + ch, size, bold) > maxWidth && piece) {
          lines.push(piece);
          piece = ch;
        } else {
          piece += ch;
        }
      }
      line = piece;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  // Draws wrapped lines going down the page; returns the y below them.
  paragraph(
    page: PDFPage,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; lineGap?: number; align?: 'left' | 'right' } = {}
  ): number {
    const size = opts.size ?? 10;
    const step = size + (opts.lineGap ?? 3);
    let cy = y;
    for (const line of this.wrap(text, maxWidth, size, opts.bold)) {
      this.draw(page, line, opts.align === 'right' ? x + maxWidth : x, cy, { ...opts, size, align: opts.align });
      cy -= step;
    }
    return cy;
  }
}

function hr(page: PDFPage, y: number, x1 = MARGIN, x2 = A4[0] - MARGIN, color = LINE, thickness = 0.8): void {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
}

function label(w: Writer, page: PDFPage, text: string, x: number, y: number, align: 'left' | 'right' = 'left'): void {
  w.draw(page, text.toUpperCase(), x, y, { size: 7.5, bold: true, color: MUTED, align });
}

function footer(w: Writer, page: PDFPage, pageNo?: number, pages?: number): void {
  hr(page, 52);
  w.draw(page, 'This is a computer-generated document and needs no signature.', MARGIN, 38, { size: 7.5, color: MUTED });
  const right = pages && pages > 1 ? `Page ${pageNo} of ${pages} · Issued through SanjeevniOS` : 'Issued through SanjeevniOS';
  w.draw(page, right, A4[0] - MARGIN, 38, { size: 7.5, color: MUTED, align: 'right' });
}

interface ClinicHeader {
  clinic_name: string;
  clinic_legal_name: string | null;
  clinic_address: string | null;
  clinic_phone: string | null;
  clinic_email: string | null;
  clinic_reg_no: string | null;
  clinic_gstin: string | null;
}

// The clinic block, top left. Returns the y below it.
function clinicBlock(w: Writer, page: PDFPage, c: ClinicHeader, top: number, maxWidth: number): number {
  const name = c.clinic_legal_name || c.clinic_name;
  let y = w.paragraph(page, name, MARGIN, top, maxWidth, { size: 15, bold: true, lineGap: 4 });
  if (c.clinic_legal_name && c.clinic_legal_name !== c.clinic_name) {
    y = w.paragraph(page, c.clinic_name, MARGIN, y, maxWidth, { size: 10, color: MUTED });
  }
  y -= 2;
  if (c.clinic_address) y = w.paragraph(page, c.clinic_address, MARGIN, y, maxWidth, { size: 8.5, color: MUTED, lineGap: 2.5 });
  const contact = [c.clinic_phone ? `Phone ${formatPhone(c.clinic_phone)}` : '', c.clinic_email ?? ''].filter(Boolean).join('  ·  ');
  if (contact) y = w.paragraph(page, contact, MARGIN, y, maxWidth, { size: 8.5, color: MUTED });
  if (c.clinic_reg_no) y = w.paragraph(page, `Registration no. ${c.clinic_reg_no}`, MARGIN, y, maxWidth, { size: 8.5, color: MUTED });
  if (c.clinic_gstin) {
    const state = gstState(c.clinic_gstin);
    y = w.paragraph(page, `GSTIN ${c.clinic_gstin}${state ? `  ·  State: ${state}` : ''}`, MARGIN, y, maxWidth, { size: 8.5, bold: true });
  }
  return y;
}

// ---------------------------------------------------------------------------
// One bill
// ---------------------------------------------------------------------------
export async function renderBillPdf(b: PatientBill, fonts: BillFonts): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${DOC_TITLE[b.doc_type]} ${b.bill_no} - ${b.clinic_legal_name || b.clinic_name}`);
  doc.setAuthor(b.clinic_legal_name || b.clinic_name);
  doc.setCreator('SanjeevniOS');
  doc.setProducer('SanjeevniOS');
  const w = new Writer(await embedFonts(doc, fonts));
  const page = doc.addPage(A4);
  const right = A4[0] - MARGIN;
  const top = A4[1] - MARGIN - 6;

  // Header: clinic (left), document (right)
  const leftBottom = clinicBlock(w, page, b, top, 300);
  w.draw(page, DOC_TITLE[b.doc_type].toUpperCase(), right, top + 1, { size: 14, bold: true, color: ACCENT, align: 'right' });
  let ry = top - 20;
  const meta: Array<[string, string]> = [
    ['No.', b.bill_no],
    ['Date', formatMomentIST(b.issued_at)],
    ['Booking ref', bookingRef(b.appointment_id)],
  ];
  for (const [k, v] of meta) {
    w.draw(page, v, right, ry, { size: 9.5, bold: k === 'No.', align: 'right' });
    w.draw(page, k, right - 118, ry, { size: 8.5, color: MUTED });
    ry -= 14;
  }
  let y = Math.min(leftBottom, ry) - 8;
  hr(page, y, MARGIN, right, INK, 1);
  y -= 22;

  // Billed to / Visit
  const colX = MARGIN + 270;
  label(w, page, 'Billed to', MARGIN, y);
  label(w, page, 'Visit', colX, y);
  let ly = w.paragraph(page, b.patient_name, MARGIN, y - 15, 240, { size: 11, bold: true });
  if (b.patient_mrn) ly = w.paragraph(page, b.patient_mrn, MARGIN, ly, 240, { size: 9, color: MUTED });
  if (b.patient_phone) ly = w.paragraph(page, formatPhone(b.patient_phone), MARGIN, ly, 240, { size: 9, color: MUTED });
  let vy = w.paragraph(page, b.doctor_name ?? 'Doctor', colX, y - 15, right - colX, { size: 11, bold: true });
  if (b.doctor_specialty) vy = w.paragraph(page, b.doctor_specialty, colX, vy, right - colX, { size: 9, color: MUTED });
  if (b.doctor_reg_no) vy = w.paragraph(page, `Registration no. ${b.doctor_reg_no}`, colX, vy, right - colX, { size: 9, color: MUTED });
  vy = w.paragraph(page, [formatDay(b.visit_date), formatClock(b.visit_time)].filter(Boolean).join(' · '), colX, vy, right - colX, { size: 9, color: MUTED });
  y = Math.min(ly, vy) - 14;

  // Charges
  const colNo = MARGIN + 8;
  const colDesc = MARGIN + 30;
  const colSac = right - 150;
  const colAmt = right - 8;
  page.drawRectangle({ x: MARGIN, y: y - 6, width: right - MARGIN, height: 20, color: SOFT });
  w.draw(page, '#', colNo, y, { size: 8.5, bold: true, color: MUTED });
  w.draw(page, 'DESCRIPTION', colDesc, y, { size: 8.5, bold: true, color: MUTED });
  w.draw(page, 'SAC', colSac, y, { size: 8.5, bold: true, color: MUTED });
  w.draw(page, 'AMOUNT', colAmt, y, { size: 8.5, bold: true, color: MUTED, align: 'right' });
  y -= 24;
  w.draw(page, '1', colNo, y, { size: 10 });
  const descBottom = w.paragraph(page, b.description, colDesc, y, colSac - colDesc - 14, { size: 10 });
  w.draw(page, b.sac_code, colSac, y, { size: 10 });
  w.draw(page, rupees(b.fee_amount), colAmt, y, { size: 10, align: 'right' });
  y = descBottom - 6;
  if (num(b.discount_amount) > 0) {
    w.draw(page, b.discount_label ?? 'Discount', colDesc, y, { size: 10, color: MUTED });
    w.draw(page, `-${rupees(b.discount_amount)}`, colAmt, y, { size: 10, color: MUTED, align: 'right' });
    y -= 18;
  }
  hr(page, y + 6);
  y -= 12;

  // Totals (right)
  const totLabelX = right - 210;
  const rows: Array<[string, string, boolean]> = [];
  if (b.doc_type === 'tax_invoice') {
    const half = num(b.gst_rate) / 2;
    const pct = Number.isInteger(half) ? String(half) : half.toFixed(1);
    rows.push(['Taxable value', rupees(b.taxable_value), false]);
    rows.push([`CGST @ ${pct}%`, rupees(b.cgst_amount), false]);
    rows.push([`SGST @ ${pct}%`, rupees(b.sgst_amount), false]);
  }
  rows.push(['Total', rupees(b.total_amount), true]);
  for (const [k, v, strong] of rows) {
    if (strong) {
      if (rows.length > 1) y -= 8; // clear of the GST lines above
      page.drawRectangle({ x: totLabelX - 10, y: y - 7, width: right - totLabelX + 10, height: 22, color: SOFT });
    }
    w.draw(page, k, totLabelX, y, { size: strong ? 11 : 9.5, bold: strong, color: strong ? INK : MUTED });
    w.draw(page, v, colAmt, y, { size: strong ? 11.5 : 9.5, bold: strong, align: 'right' });
    y -= strong ? 26 : 16;
  }

  y = w.paragraph(page, rupeesInWords(b.total_amount), MARGIN, y - 2, right - MARGIN, { size: 9, bold: true }) - 2;
  if (b.doc_type === 'bill_of_supply') {
    y = w.paragraph(page, 'GST not charged: health care services by a clinic or doctor are exempt from GST.', MARGIN, y, right - MARGIN, { size: 8.5, color: MUTED });
  } else if (b.doc_type === 'tax_invoice') {
    y = w.paragraph(page, 'Prices include GST. Place of supply: the clinic\'s state.', MARGIN, y, right - MARGIN, { size: 8.5, color: MUTED });
  }
  y -= 18;

  // Payment
  label(w, page, 'Payment', MARGIN, y);
  y = w.paragraph(page, paymentLine(b), MARGIN, y - 15, right - MARGIN, { size: 10, lineGap: 4 });

  footer(w, page);
  return doc.save();
}

// ---------------------------------------------------------------------------
// Several bills: a patient's statement, or a clinic's register for dates
// ---------------------------------------------------------------------------
export interface BillListOptions {
  title: string; // 'Statement of bills' / 'Bills register'
  subtitle: string; // patient and/or period
  clinic: ClinicHeader;
  bills: PatientBill[]; // newest first or oldest first - drawn as given
  showPatient: boolean;
  generatedAt: string; // ISO moment
}

export async function renderBillListPdf(o: BillListOptions, fonts: BillFonts): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${o.title} - ${o.clinic.clinic_legal_name || o.clinic.clinic_name}`);
  doc.setAuthor(o.clinic.clinic_legal_name || o.clinic.clinic_name);
  doc.setCreator('SanjeevniOS');
  doc.setProducer('SanjeevniOS');
  const w = new Writer(await embedFonts(doc, fonts));
  const right = A4[0] - MARGIN;
  const bottomLimit = 70;

  // Columns
  const cols = o.showPatient
    ? { date: MARGIN, no: MARGIN + 62, patient: MARGIN + 150, doctor: MARGIN + 290, amount: right - 70, pay: right }
    : { date: MARGIN, no: MARGIN + 70, patient: -1, doctor: MARGIN + 170, amount: right - 85, pay: right };

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const tableHeader = () => {
    page.drawRectangle({ x: MARGIN - 4, y: y - 6, width: right - MARGIN + 8, height: 20, color: SOFT });
    w.draw(page, 'DATE', cols.date, y, { size: 8, bold: true, color: MUTED });
    w.draw(page, 'BILL NO.', cols.no, y, { size: 8, bold: true, color: MUTED });
    if (o.showPatient) w.draw(page, 'PATIENT', cols.patient, y, { size: 8, bold: true, color: MUTED });
    w.draw(page, 'DOCTOR', cols.doctor, y, { size: 8, bold: true, color: MUTED });
    w.draw(page, 'AMOUNT', cols.amount, y, { size: 8, bold: true, color: MUTED, align: 'right' });
    w.draw(page, 'PAYMENT', cols.pay, y, { size: 8, bold: true, color: MUTED, align: 'right' });
    y -= 22;
  };
  const newPage = (first: boolean) => {
    page = doc.addPage(A4);
    pages.push(page);
    const top = A4[1] - MARGIN - 6;
    if (first) {
      const leftBottom = clinicBlock(w, page, o.clinic, top, 300);
      w.draw(page, o.title.toUpperCase(), right, top + 1, { size: 13, bold: true, color: ACCENT, align: 'right' });
      let ry = w.paragraph(page, o.subtitle, right - 200, top - 18, 200, { size: 9, align: 'right' });
      w.draw(page, `Prepared ${formatMomentIST(o.generatedAt)}`, right, ry, { size: 8.5, color: MUTED, align: 'right' });
      ry -= 12;
      y = Math.min(leftBottom, ry) - 8;
      hr(page, y, MARGIN, right, INK, 1);
      y -= 24;
    } else {
      w.draw(page, `${o.title} · ${o.clinic.clinic_legal_name || o.clinic.clinic_name}`, MARGIN, top, { size: 9, bold: true });
      w.draw(page, o.subtitle, right, top, { size: 8.5, color: MUTED, align: 'right' });
      y = top - 26;
    }
    tableHeader();
  };
  newPage(true);

  const clip = (text: string, maxW: number, size: number, bold = false) => {
    if (w.width(text, size, bold) <= maxW) return text;
    let t = text;
    while (t.length > 1 && w.width(t + '…', size, bold) > maxW) t = t.slice(0, -1);
    return t + '…';
  };

  let billed = 0;
  let paid = 0;
  let due = 0;
  for (const b of o.bills) {
    if (y < bottomLimit + 30) newPage(false);
    const total = num(b.total_amount);
    billed += total;
    if (b.payment_status === 'pay_at_clinic') due += total;
    else if (b.payment_status !== 'refunded') paid += total;
    w.draw(page, formatMomentIST(b.issued_at), cols.date, y, { size: 8.5 });
    w.draw(page, b.bill_no, cols.no, y, { size: 8.5, bold: true });
    if (o.showPatient) {
      w.draw(page, clip(b.patient_name, cols.doctor - cols.patient - 8, 8.5), cols.patient, y, { size: 8.5 });
      if (b.patient_mrn) w.draw(page, b.patient_mrn, cols.patient, y - 10, { size: 7.5, color: MUTED });
    }
    const doctorWidth = cols.amount - 70 - cols.doctor;
    w.draw(page, clip(b.doctor_name ?? '', doctorWidth, 8.5), cols.doctor, y, { size: 8.5 });
    w.draw(page, `Visit ${formatDay(b.visit_date)}`, cols.doctor, y - 10, { size: 7.5, color: MUTED });
    w.draw(page, rupees(total), cols.amount, y, { size: 8.5, align: 'right' });
    w.draw(page, PAYMENT_SHORT[b.payment_status] ?? b.payment_status, cols.pay, y, {
      size: 8.5,
      color: b.payment_status === 'pay_at_clinic' ? rgb(0.71, 0.33, 0.04) : MUTED,
      align: 'right',
    });
    y -= 14;
    hr(page, y + 2);
    y -= 12;
  }

  if (o.bills.length === 0) {
    w.draw(page, 'No bills in this period.', MARGIN, y, { size: 10, color: MUTED });
    y -= 20;
  }

  if (y < bottomLimit + 70) newPage(false);
  y -= 6;
  const summary: Array<[string, string, boolean]> = [
    ['Bills', String(o.bills.length), false],
    ['Billed', rupees(billed), true],
    ['Paid', rupees(paid), false],
    ['Due', rupees(due), false],
  ];
  for (const [k, v, strong] of summary) {
    w.draw(page, k, right - 200, y, { size: strong ? 10.5 : 9.5, bold: strong, color: strong ? INK : MUTED });
    w.draw(page, v, right, y, { size: strong ? 10.5 : 9.5, bold: strong, align: 'right' });
    y -= 16;
  }

  pages.forEach((p, i) => footer(w, p, i + 1, pages.length));
  return doc.save();
}
