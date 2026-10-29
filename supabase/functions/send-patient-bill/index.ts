// supabase/functions/send-patient-bill/index.ts
//
// Sends a patient's bill (migration 89 - issued by the clinic when a visit is
// completed) as a PDF: by WhatsApp and by email. The clinic app calls it right
// after completing a visit, and from "Send again" on the Patient bills screen.
// The PDF is drawn by _shared/billPdf.ts - the same code the app uses for
// downloads - so every copy is identical.
//
// Recipient: always the bill's own patient, from the database - never from
// the request. Their own phone/email, else the account holder's (parent of a
// child) - but never the clinic's own login, which walk-ins are filed under
// until the patient signs up.
//
// Each channel is optional and simply skipped (reported, not an error) when
// it isn't configured - same contract as send-patient-message:
//   WhatsApp (MSG91): MSG91_AUTH_KEY, MSG91_WHATSAPP_SENDER and
//     MSG91_WHATSAPP_BILL_TEMPLATE - an APPROVED template with a DOCUMENT
//     header and one body variable, e.g.
//       "Your bill {{1}} is attached. Thank you for visiting."
//     Check the exact request shape in your MSG91 dashboard's API panel (see
//     WHATSAPP_OTP_MSG91.md); this assumes header_1 = document, body_1 = text.
//   Email (Resend): RESEND_API_KEY, RESEND_FROM_EMAIL
//   SITE_URL (optional, default https://www.sanjeevnios.in): where the
//     bill fonts are served (public/fonts on the website).
//
// Deploy: scripts/deploy-functions.sh (or npx supabase functions deploy
// send-patient-bill). deno.json next to this file maps the PDF libraries.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { audit, authenticate } from '../_shared/authorize.ts';
import {
  BILL_FONT_FILES,
  DOC_TITLE,
  billTextFields,
  formatINR,
  formatMomentIST,
  needsDevanagari,
  renderBillPdf,
  type BillFonts,
  type PatientBill,
} from '../_shared/billPdf.ts';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MSG91_AUTH_KEY = Deno.env.get('MSG91_AUTH_KEY');
const MSG91_WHATSAPP_SENDER = Deno.env.get('MSG91_WHATSAPP_SENDER');
const MSG91_WHATSAPP_BILL_TEMPLATE = Deno.env.get('MSG91_WHATSAPP_BILL_TEMPLATE');
const MSG91_ENDPOINT = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL');
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://www.sanjeevnios.in').replace(/\/+$/, '');
const BUCKET = 'patient-bills';
// The WhatsApp document link MSG91 fetches the PDF from.
const LINK_SECONDS = 7 * 24 * 3600;
// Two taps on "Send again" (or completion + a quick resend) send once.
const RESEND_COOLDOWN_MS = 60_000;

// The allowed origin is added per request (website or app): _shared/cors.ts.
const CORS_HEADERS = {
  'Vary': 'Origin',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

const fontCache = new Map<string, Promise<Uint8Array>>();
function font(file: string): Promise<Uint8Array> {
  let p = fontCache.get(file);
  if (!p) {
    p = fetch(`${SITE_URL}/fonts/${file}`).then(async (r) => {
      if (!r.ok) throw new Error(`font ${file}: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      // The website answers a missing file with its own page (200, HTML).
      const tag = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
      const isFont = (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || tag === 'true' || tag === 'OTTO';
      if (!isFont) throw new Error(`font ${file}: not found on ${SITE_URL} (deploy the website first)`);
      return bytes;
    });
    p.catch(() => fontCache.delete(file));
    fontCache.set(file, p);
  }
  return p;
}

async function fontsFor(bill: PatientBill): Promise<BillFonts> {
  const deva = needsDevanagari(billTextFields(bill));
  const [regular, bold, devanagari, devanagariBold] = await Promise.all([
    font(BILL_FONT_FILES.regular),
    font(BILL_FONT_FILES.bold),
    deva ? font(BILL_FONT_FILES.devanagari) : Promise.resolve(undefined),
    deva ? font(BILL_FONT_FILES.devanagariBold) : Promise.resolve(undefined),
  ]);
  return { regular, bold, devanagari, devanagariBold };
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const escapeHtml = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const toWhatsAppNumber = (phone: string) => {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
};

Deno.serve(withCors(CORS_HEADERS, async (req) => {
  // 1. WHO
  const auth = await authenticate(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const { caller } = auth;

  let body: { billId?: string; appointmentId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  if (!body.billId && !body.appointmentId) return json({ error: 'billId or appointmentId is required.' }, 400);

  // 4. THIS RESOURCE - as the caller, so someone else's bill is "not found".
  const query = caller.client.from('patient_bills').select('*');
  const { data: found } = await (body.billId ? query.eq('id', body.billId) : query.eq('appointment_id', body.appointmentId!)).maybeSingle();
  if (!found) return json({ error: 'Bill not found.' }, 404);
  const bill = found as PatientBill & {
    clinic_id: string;
    member_id: string;
    whatsapp_sent_at: string | null;
    email_sent_at: string | null;
  };

  // 2 + 3. ALLOWED - the issuing clinic, an admin, or the patient themselves
  // (row-level security already limited `found` to exactly those).
  const isClinic = !!caller.clinicId && caller.clinicId === bill.clinic_id;

  const lastSent = Math.max(
    bill.whatsapp_sent_at ? Date.parse(bill.whatsapp_sent_at) : 0,
    bill.email_sent_at ? Date.parse(bill.email_sent_at) : 0
  );
  if (Date.now() - lastSent < RESEND_COOLDOWN_MS) {
    return json({ whatsapp: 'skipped:just_sent', email: 'skipped:just_sent' });
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // The patient's contacts, as they are now (a walk-in may have signed up).
  const { data: member } = await db.from('family_members').select('account_id, phone, email').eq('id', bill.member_id).maybeSingle();
  let phone: string | null = (member?.phone as string | null) || null;
  let email: string | null = ((member?.email as string | null) || '').trim() || null;
  if (member?.account_id && (!phone || !email)) {
    const { data: holder } = await db.from('profiles').select('role, phone').eq('id', member.account_id).maybeSingle();
    if (holder?.role === 'patient') {
      phone = phone ?? ((holder.phone as string | null) || null);
      if (!email) {
        const { data: self } = await db
          .from('family_members')
          .select('email')
          .eq('account_id', member.account_id)
          .eq('relation', 'self')
          .order('created_at')
          .limit(1)
          .maybeSingle();
        email = ((self?.email as string | null) || '').trim() || null;
      }
    }
  }

  const wantWhatsApp = !!(MSG91_AUTH_KEY && MSG91_WHATSAPP_SENDER && MSG91_WHATSAPP_BILL_TEMPLATE);
  const wantEmail = !!(RESEND_API_KEY && RESEND_FROM_EMAIL);
  let whatsapp = wantWhatsApp ? (phone ? 'pending' : 'skipped:no_phone') : 'skipped:not_configured';
  let mail = wantEmail ? (email ? 'pending' : 'skipped:no_email') : 'skipped:not_configured';
  if (whatsapp !== 'pending' && mail !== 'pending') return json({ whatsapp, email: mail });

  const title = DOC_TITLE[bill.doc_type];
  const issuer = bill.clinic_legal_name || bill.clinic_name;
  const fileName = `${title.replace(/\s+/g, '-')}-${bill.bill_no.replace(/\//g, '-')}.pdf`;
  let pdf: Uint8Array;
  try {
    pdf = await renderBillPdf(bill, await fontsFor(bill));
  } catch (e) {
    await db.from('patient_bills').update({ last_send_error: `PDF: ${String(e).slice(0, 300)}` }).eq('id', bill.id);
    return json({ error: 'Could not prepare the bill PDF.' }, 500);
  }

  const errors: string[] = [];
  const update: Record<string, unknown> = {};

  if (mail === 'pending' && email) {
    try {
      const amount = `Rs. ${formatINR(bill.total_amount)}`;
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: [email],
          subject: `${title} ${bill.bill_no} from ${issuer}`,
          text: `Dear ${bill.patient_name},\n\nYour ${title.toLowerCase()} ${bill.bill_no} from ${issuer} for your visit with ${bill.doctor_name ?? 'the doctor'} on ${formatMomentIST(bill.issued_at)} (${amount}) is attached as a PDF.\n\nYou can also download it any time in the SanjeevniOS app.\n\n${issuer}`,
          html: `<p>Dear ${escapeHtml(bill.patient_name)},</p><p>Your ${escapeHtml(title.toLowerCase())} <strong>${escapeHtml(bill.bill_no)}</strong> from ${escapeHtml(issuer)} for your visit with ${escapeHtml(bill.doctor_name ?? 'the doctor')} (${escapeHtml(amount)}) is attached as a PDF.</p><p>You can also download it any time in the SanjeevniOS app.</p><p>${escapeHtml(issuer)}</p>`,
          attachments: [{ filename: fileName, content: base64(pdf) }],
        }),
      });
      if (res.ok) {
        mail = 'sent';
        update.email_sent_at = new Date().toISOString();
        update.email_sent_to = email;
      } else {
        mail = `failed:${res.status}`;
        errors.push(`email ${res.status}`);
      }
    } catch (e) {
      mail = 'failed';
      errors.push(`email ${String(e).slice(0, 120)}`);
    }
  }

  if (whatsapp === 'pending' && phone) {
    try {
      const path = `${bill.clinic_id}/${bill.id}.pdf`;
      const up = await db.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true });
      if (up.error) throw new Error(`storage: ${up.error.message}`);
      const signed = await db.storage.from(BUCKET).createSignedUrl(path, LINK_SECONDS);
      if (signed.error || !signed.data?.signedUrl) throw new Error(`link: ${signed.error?.message ?? 'none'}`);
      const res = await fetch(MSG91_ENDPOINT, {
        method: 'POST',
        headers: { authkey: MSG91_AUTH_KEY!, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrated_number: MSG91_WHATSAPP_SENDER,
          content_type: 'template',
          payload: {
            messaging_product: 'whatsapp',
            type: 'template',
            template: {
              name: MSG91_WHATSAPP_BILL_TEMPLATE,
              language: { code: 'en', policy: 'deterministic' },
              to_and_components: [
                {
                  to: [toWhatsAppNumber(phone)],
                  components: {
                    header_1: { type: 'document', filename: fileName, value: signed.data.signedUrl },
                    body_1: { type: 'text', value: `${bill.bill_no} from ${issuer}` },
                  },
                },
              ],
            },
          },
        }),
      });
      if (res.ok) {
        whatsapp = 'sent';
        update.whatsapp_sent_at = new Date().toISOString();
      } else {
        whatsapp = `failed:${res.status}`;
        errors.push(`whatsapp ${res.status}`);
      }
    } catch (e) {
      whatsapp = 'failed';
      errors.push(`whatsapp ${String(e).slice(0, 160)}`);
    }
  }

  update.last_send_error = errors.length ? errors.join('; ') : null;
  update.updated_at = new Date().toISOString();
  await db.from('patient_bills').update(update).eq('id', bill.id);
  if (whatsapp === 'sent' || mail === 'sent') {
    await audit(db, caller, isClinic || caller.isAdmin ? 'patient_bill_sent' : 'patient_bill_sent_by_patient', bill.id);
  }
  return json({ whatsapp, email: mail });
}));
