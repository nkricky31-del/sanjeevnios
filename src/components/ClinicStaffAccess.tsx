import { Copy, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { livePhoneDigits } from '../lib/phone';
import { supabase } from '../lib/supabaseClient';
import type { Clinic } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import SectionTitle from './ui/SectionTitle';

interface Props {
  clinic: Clinic;
  onClinicSaved: (patch: Partial<Clinic>) => void;
}

interface StaffPhoneRow {
  id: string;
  phone: string;
  label: string | null;
}

// A phone number stored the normalized way everywhere else in this app
// (family_members.phone, profiles.phone - see src/lib/phone.ts) is just
// "91" + 10 digits, no punctuation - this turns that back into
// "+91 98765 43210" for display only.
function formatPhone(phone: string): string {
  const local = phone.startsWith('91') ? phone.slice(2) : phone;
  return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
}

// The Clinic ID (assigned once an admin approves this clinic - schema.sql
// migration 57), the clinic's own staff phone roster, and the contact email
// approval notices go to. Lives in its own console tab ("Login & Staff")
// rather than folded into ClinicBookingMode.tsx or similar, since none of
// this is a booking setting - it's who's allowed to sign in at all.
export default function ClinicStaffAccess({ clinic, onClinicSaved }: Props) {
  const [staff, setStaff] = useState<StaffPhoneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newDigits, setNewDigits] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState(clinic.contact_email ?? '');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailNote, setEmailNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadStaff = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('clinic_staff_phones')
      .select('id, phone, label')
      .eq('clinic_id', clinic.id)
      .order('created_at', { ascending: true });
    setStaff((data ?? []) as StaffPhoneRow[]);
    setLoading(false);
  }, [clinic.id]);

  useEffect(() => {
    loadStaff();
  }, [loadStaff]);

  const copyCode = async () => {
    if (!clinic.clinic_code) return;
    try {
      await navigator.clipboard.writeText(clinic.clinic_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail silently (permissions, non-HTTPS) - the
      // code is already shown on screen either way, so this is a nicety,
      // not something worth surfacing an error for.
    }
  };

  const addPhone = async (e: FormEvent) => {
    e.preventDefault();
    setAddError(null);
    if (newDigits.length !== 10) {
      setAddError('Enter a 10-digit phone number.');
      return;
    }
    setAdding(true);
    const { error } = await supabase.rpc('add_clinic_staff_phone', {
      p_phone: newDigits,
      p_label: newLabel.trim() || null,
    });
    setAdding(false);
    if (error) {
      setAddError(error.message);
      return;
    }
    setNewDigits('');
    setNewLabel('');
    loadStaff();
  };

  const removePhone = async (id: string) => {
    await supabase.from('clinic_staff_phones').delete().eq('id', id);
    loadStaff();
  };

  const saveEmail = async () => {
    setEmailSaving(true);
    setEmailNote(null);
    const trimmed = email.trim();
    const { error } = await supabase
      .from('clinics')
      .update({ contact_email: trimmed || null })
      .eq('id', clinic.id);
    setEmailSaving(false);
    if (error) {
      setEmailNote(error.message);
      return;
    }
    onClinicSaved({ contact_email: trimmed || null });
    setEmailNote('Saved.');
  };

  return (
    <div>
      <SectionTitle>Login & staff access</SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">
        Who can sign in to this clinic's console, and where approval notices go.
      </p>

      <Card className="mt-2">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Clinic ID</p>
        {clinic.clinic_code ? (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="rounded-xl bg-brand-50 px-3 py-2 font-mono text-lg font-extrabold text-brand-700">
              {clinic.clinic_code}
            </span>
            <button
              type="button"
              onClick={copyCode}
              className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label="Copy Clinic ID"
            >
              <Copy size={16} />
            </button>
            {copied && <span className="text-xs font-semibold text-emerald-600">Copied</span>}
          </div>
        ) : (
          <p className="mt-1.5 text-sm text-slate-500">
            Issued automatically once an admin approves this clinic - check back after that.
          </p>
        )}
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-slate-400">
          <ShieldCheck size={14} className="mt-0.5 shrink-0" />
          Staff sign in with this Clinic ID plus one of the phone numbers below (OTP required either way) - never an
          MRN, and this ID alone never signs anyone in without also proving a registered phone.
        </p>
      </Card>

      <SectionTitle className="mt-5">Staff phone numbers</SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">
        Any of these - plus this clinic's own registered owner phone - works with the Clinic ID above.
      </p>
      <Card className="mt-2 !p-0">
        <div className="flex items-center gap-3 border-b border-slate-50 px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-500">
            Owner
          </span>
          <p className="text-sm text-slate-500">The phone this clinic was originally registered with.</p>
        </div>
        {loading && <p className="px-4 py-4 text-sm text-slate-400">Loading...</p>}
        {!loading && staff.length === 0 && (
          <p className="px-4 py-4 text-sm text-slate-400">No additional staff phones added yet.</p>
        )}
        {staff.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-3 border-b border-slate-50 px-4 py-3 last:border-b-0">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-slate-900">{formatPhone(s.phone)}</p>
              {s.label && <p className="truncate text-xs text-slate-400">{s.label}</p>}
            </div>
            <button
              type="button"
              onClick={() => removePhone(s.id)}
              className="shrink-0 rounded-full p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
              aria-label={`Remove ${formatPhone(s.phone)}`}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </Card>

      <form onSubmit={addPhone} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <div className="flex flex-1 items-center overflow-hidden rounded-2xl border border-slate-200 bg-white focus-within:ring-2 focus-within:ring-brand-500">
          <span className="border-r border-slate-200 px-3 py-2.5 text-sm font-bold text-slate-700">+91</span>
          <input
            type="tel"
            inputMode="numeric"
            maxLength={15}
            value={newDigits}
            onChange={(e) => setNewDigits(livePhoneDigits(e.target.value))}
            placeholder="Staff mobile number"
            className="w-full bg-transparent px-3 py-2.5 text-sm font-medium outline-none placeholder:text-slate-400"
          />
        </div>
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label (optional, e.g. Front desk)"
          className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500 sm:w-52"
        />
        <Button type="submit" disabled={adding}>
          {adding ? 'Adding...' : 'Add'}
        </Button>
      </form>
      {addError && <p className="mt-2 text-sm text-red-600">{addError}</p>}

      <SectionTitle className="mt-5">Contact email</SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">Where future approval/verification notices are emailed.</p>
      <Card className="mt-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="clinic@example.com"
          className="w-full rounded-2xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
        {emailNote && (
          <p className={`mt-2 text-sm ${emailNote === 'Saved.' ? 'font-semibold text-emerald-600' : 'text-red-600'}`}>
            {emailNote}
          </p>
        )}
        <Button variant="secondary" onClick={saveEmail} disabled={emailSaving} className="mt-3">
          {emailSaving ? 'Saving...' : 'Save email'}
        </Button>
      </Card>
    </div>
  );
}
