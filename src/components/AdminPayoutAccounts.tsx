import Loading from './ui/Loading';
import AdminDrill, { type DrillView } from './AdminDrill';
import { Banknote, CheckCircle2, Clock, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { describeFunctionError } from '../lib/razorpay';
import { supabase } from '../lib/supabaseClient';
import type { ClinicPayoutAccountStatus } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import IconTile from './ui/IconTile';
import StatusPill from './ui/StatusPill';

interface ClinicRow {
  id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  razorpay_fund_account_id: string | null;
  razorpay_account_status: ClinicPayoutAccountStatus;
  razorpay_account_note: string | null;
}

const STATUS_TONE: Record<ClinicPayoutAccountStatus, 'live' | 'warning' | 'info' | 'neutral' | 'danger'> = {
  not_started: 'neutral',
  requested: 'warning',
  under_review: 'warning',
  needs_clarification: 'danger',
  activated: 'live',
  suspended: 'danger',
};

const STATUS_LABEL: Record<ClinicPayoutAccountStatus, string> = {
  not_started: 'Not set up',
  requested: 'Requested',
  under_review: 'Under review',
  needs_clarification: 'Needs clarification',
  activated: 'Active',
  suspended: 'Suspended',
};

const BUSINESS_TYPES = [
  'proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited',
  'trust', 'ngo', 'society', 'individual', 'not_yet_registered', 'educational_institutes', 'other',
];

interface FormState {
  email: string;
  phone: string;
  legalBusinessName: string;
  businessType: string;
  contactName: string;
  pan: string;
  street1: string;
  city: string;
  state: string;
  postalCode: string;
  accountNumber: string;
  ifscCode: string;
  beneficiaryName: string;
}

function blankForm(clinic: ClinicRow): FormState {
  return {
    email: clinic.contact_email ?? '',
    phone: clinic.contact_phone ?? '',
    legalBusinessName: clinic.name,
    businessType: 'proprietorship',
    contactName: '',
    pan: '',
    street1: '',
    city: '',
    state: '',
    postalCode: '',
    accountNumber: '',
    ifscCode: '',
    beneficiaryName: '',
  };
}

const inputClass =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400';

// Route linked-account onboarding (migration 64) - collects a clinic's KYC
// and settlement bank details ONCE, forwards them straight to Razorpay via
// create-clinic-linked-account, and never writes any of it into our own
// database - only the resulting Razorpay account id and activation status
// (razorpay_fund_account_id/razorpay_account_status) are persisted, by that
// edge function itself. This form's state is the only place the raw values
// ever live client-side, and it's discarded the moment the request settles.
export default function AdminPayoutAccounts() {
  const [clinics, setClinics] = useState<ClinicRow[]>([]);
  const [drill, setDrill] = useState<DrillView | null>(null);
  const [loading, setLoading] = useState(true);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('clinics')
      .select('id, name, contact_email, contact_phone, razorpay_fund_account_id, razorpay_account_status, razorpay_account_note')
      .eq('status', 'approved')
      .order('name', { ascending: true });
    setClinics((data ?? []) as ClinicRow[]);
    setLoading(false);
  };

  // No Razorpay webhook is configured for product.route.* events (migration
  // 65) - this is the only thing that ever moves a status forward after
  // submission, by asking Razorpay directly instead of waiting for it to
  // tell us.
  const checkStatus = async (clinicId: string) => {
    setError(null);
    setNote(null);
    setCheckingId(clinicId);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('check-clinic-payout-account-status', {
        body: { clinicId },
      });
      if (fnError) {
        setError(await describeFunctionError(fnError));
        return;
      }
      const result = data as { error?: string; status?: string; note?: string | null };
      if (result?.error) {
        setError(result.error);
        return;
      }
      setNote(`Status: ${result.status}${result.note ? ` - ${result.note}` : ''}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check this payout account.');
    } finally {
      setCheckingId(null);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openForm = (clinic: ClinicRow) => {
    setError(null);
    setNote(null);
    setForm(blankForm(clinic));
    setOpenFor((prev) => (prev === clinic.id ? null : clinic.id));
  };

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((prev) => (prev ? { ...prev, [key]: e.target.value } : prev));

  const submit = async (clinicId: string) => {
    if (!form) return;
    setError(null);
    setNote(null);
    if (!form.email || !form.phone || !form.legalBusinessName || !form.accountNumber || !form.ifscCode || !form.beneficiaryName) {
      setError('Email, phone, legal business name, and the full bank account block are required.');
      return;
    }
    setSubmitting(true);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('create-clinic-linked-account', {
        body: {
          clinicId,
          email: form.email,
          phone: form.phone,
          legalBusinessName: form.legalBusinessName,
          businessType: form.businessType,
          contactName: form.contactName || undefined,
          pan: form.pan || undefined,
          address: { street1: form.street1, city: form.city, state: form.state, postalCode: form.postalCode },
          bank: { accountNumber: form.accountNumber, ifscCode: form.ifscCode, beneficiaryName: form.beneficiaryName },
        },
      });
      if (fnError) {
        setError(await describeFunctionError(fnError));
        return;
      }
      const result = data as { error?: string; status?: string; note?: string | null };
      if (result?.error) {
        setError(result.error);
        return;
      }
      setNote(`Status: ${result.status}${result.note ? ` - ${result.note}` : ''}`);
      setOpenFor(null);
      setForm(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set up this payout account.');
    } finally {
      setSubmitting(false);
    }
  };

  const renderSetup = (c: ClinicRow) => (
    <>
              {c.razorpay_account_status !== 'activated' && (
                <div className="mt-2 flex gap-2">
                  <Button variant="secondary" onClick={() => openForm(c)}>
                    {c.razorpay_fund_account_id ? 'Retry setup' : 'Set up payout account'}
                  </Button>
                  {c.razorpay_fund_account_id && (
                    <Button variant="ghost" onClick={() => checkStatus(c.id)} disabled={checkingId === c.id}>
                      {checkingId === c.id ? 'Checking...' : 'Check status'}
                    </Button>
                  )}
                </div>
              )}

              {openFor === c.id && form && (
                <div className="mt-3 space-y-2 rounded-2xl bg-slate-50 p-3">
                  {error && <p className="text-sm text-red-600">{error}</p>}
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Business details</p>
                  <input className={inputClass} placeholder="Legal business name" value={form.legalBusinessName} onChange={set('legalBusinessName')} />
                  <select className={inputClass} value={form.businessType} onChange={set('businessType')}>
                    {BUSINESS_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                  <input className={inputClass} placeholder="Contact person name" value={form.contactName} onChange={set('contactName')} />
                  <input className={inputClass} placeholder="Business email" value={form.email} onChange={set('email')} />
                  <input className={inputClass} placeholder="Business phone" value={form.phone} onChange={set('phone')} />
                  <input className={inputClass} placeholder="PAN (optional)" value={form.pan} onChange={set('pan')} />
                  <div className="grid grid-cols-2 gap-2">
                    <input className={inputClass} placeholder="Street" value={form.street1} onChange={set('street1')} />
                    <input className={inputClass} placeholder="City" value={form.city} onChange={set('city')} />
                    <input className={inputClass} placeholder="State" value={form.state} onChange={set('state')} />
                    <input className={inputClass} placeholder="Postal code" value={form.postalCode} onChange={set('postalCode')} />
                  </div>
                  <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Settlement bank account</p>
                  <input className={inputClass} placeholder="Account holder / beneficiary name" value={form.beneficiaryName} onChange={set('beneficiaryName')} />
                  <div className="grid grid-cols-2 gap-2">
                    <input className={inputClass} placeholder="Account number" value={form.accountNumber} onChange={set('accountNumber')} />
                    <input className={inputClass} placeholder="IFSC code" value={form.ifscCode} onChange={set('ifscCode')} />
                  </div>
                  <p className="text-[11px] text-slate-400">
                    By submitting, you confirm this clinic has agreed to Razorpay's Route terms for receiving split settlements.
                  </p>
                  <div className="flex gap-2 pt-1">
                    <Button onClick={() => submit(c.id)} disabled={submitting}>
                      {submitting ? 'Submitting...' : 'Submit to Razorpay'}
                    </Button>
                    <Button variant="ghost" onClick={() => setOpenFor(null)} disabled={submitting}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
    </>
  );

  if (drill) {
    const sel = drill.kind === 'payout' ? clinics.find((c) => c.id === drill.clinicId) : null;
    return (
      <div>
        <AdminDrill view={drill} onChange={setDrill} onClose={() => { setDrill(null); setOpenFor(null); }} />
        {sel && (
          <Card className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Payout account setup</p>
            {sel.razorpay_account_status === 'activated' && <p className="mt-2 text-sm text-emerald-700">This clinic's payout account is active. Nothing to set up.</p>}
            {note && <p className="mt-2 text-sm font-semibold text-emerald-600">{note}</p>}
            {renderSetup(sel)}
          </Card>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">Payout accounts</h2>
        <button onClick={load} className="text-sm font-medium text-brand-600">
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Sets up each clinic's Razorpay Route linked account, so released settlements (see Settlements) transfer
        automatically instead of needing a manual bank payment. KYC and bank details are sent straight to Razorpay -
        nothing here is stored in our own database beyond the resulting account id and status.
      </p>

      {note && <p className="mt-2 text-sm font-semibold text-emerald-600">{note}</p>}

      {loading && <p className="mt-3 text-sm text-slate-400"><Loading /></p>}

      <div className="mt-3 space-y-3">
        {clinics.map((c) => {
          const icon = c.razorpay_account_status === 'activated' ? CheckCircle2 : c.razorpay_account_status === 'needs_clarification' || c.razorpay_account_status === 'suspended' ? ShieldAlert : c.razorpay_account_status === 'not_started' ? Banknote : Clock;
          return (
            <Card key={c.id} onOpen={() => setDrill({ kind: 'payout', clinicId: c.id })} accent={c.razorpay_account_status === 'activated' ? '#10b981' : '#0ea5e9'}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <IconTile icon={icon} size="sm" tone={c.razorpay_account_status === 'activated' ? 'emerald' : c.razorpay_account_status === 'needs_clarification' || c.razorpay_account_status === 'suspended' ? 'pink' : 'slate'} />
                  <p className="truncate font-bold text-slate-900">{c.name}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill label={STATUS_LABEL[c.razorpay_account_status]} tone={STATUS_TONE[c.razorpay_account_status]} />
                </div>
              </div>
              {c.razorpay_fund_account_id && (
                <p className="mt-1 truncate font-mono text-[11px] text-slate-400">account: {c.razorpay_fund_account_id}</p>
              )}
              {c.razorpay_account_note && <p className="mt-1 text-xs text-red-600">{c.razorpay_account_note}</p>}

            </Card>
          );
        })}
        {!loading && clinics.length === 0 && <p className="text-sm text-slate-400">No approved clinics yet.</p>}
      </div>
    </div>
  );
}
