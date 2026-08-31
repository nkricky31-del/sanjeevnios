import { useEffect, useRef, useState } from 'react';

import { AGREEMENT_TEXT, AGREEMENT_VERSION, getClientIp } from '../lib/consent';
import { openVerificationDoc, VERIFICATION_DOCS_BUCKET } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { Consent } from '../lib/types';
import Button from './ui/Button';
import StatusPill from './ui/StatusPill';

interface Props {
  doctorId: string;
  onSigned?: () => void;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

export default function AgreementConsentForm({ doctorId, onSigned }: Props) {
  const [consent, setConsent] = useState<Consent | null | undefined>(undefined); // undefined = loading
  const [signatureName, setSignatureName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    // Latest signature wins if this doctor was ever re-signed for a newer
    // agreement version - same "latest row wins" pattern used elsewhere.
    const { data } = await supabase
      .from('consents')
      .select('*')
      .eq('doctor_id', doctorId)
      .order('agreed_at', { ascending: false })
      .limit(1);
    setConsent((data ?? [])[0] ?? null);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId]);

  const submit = async () => {
    setError(null);
    if (!signatureName.trim()) {
      setError("Type the doctor's full name as their signature.");
      return;
    }
    if (!agreed) {
      setError('Tick "I have read and agree" to continue.');
      return;
    }
    const file = fileRef.current?.files?.[0] ?? null;
    if (file) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        setError('The signed copy must be a JPG, PNG, or PDF.');
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError('The signed copy must be under 10MB.');
        return;
      }
    }

    setSaving(true);

    let fileUrl: string | null = null;
    if (file) {
      const path = `doctors/${doctorId}/consent-signed-copy/${crypto.randomUUID()}-${file.name}`;
      const { error: uploadError } = await supabase.storage.from(VERIFICATION_DOCS_BUCKET).upload(path, file, {
        contentType: file.type,
      });
      if (uploadError) {
        setSaving(false);
        setError(`Could not upload the signed copy: ${uploadError.message}`);
        return;
      }
      fileUrl = path;
    }

    const ip = await getClientIp();

    const { error: insertError } = await supabase.from('consents').insert({
      doctor_id: doctorId,
      agreement_version: AGREEMENT_VERSION,
      signature_name: signatureName.trim(),
      ip,
      file_url: fileUrl,
    });

    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    await load();
    onSigned?.();
  };

  if (consent === undefined) return <p className="text-sm text-slate-400">Loading agreement...</p>;

  const upToDate = consent?.agreement_version === AGREEMENT_VERSION;

  if (consent && upToDate) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-emerald-800">Agreement signed</p>
          <StatusPill label="Signed" tone="live" />
        </div>
        <p className="mt-1 text-xs text-emerald-700">
          Signed by {consent.signature_name} on {new Date(consent.agreed_at).toLocaleString()}
          {consent.ip && ` from IP ${consent.ip}`}.
        </p>
        {consent.file_url && (
          <button
            onClick={() => openVerificationDoc(consent.file_url!)}
            className="mt-1 text-xs font-semibold text-emerald-700 underline"
          >
            View uploaded signed copy
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 p-4">
      <p className="text-sm font-bold text-slate-900">Agreement to join SanjeevniOS</p>
      {consent && !upToDate && (
        <p className="mt-1 text-xs text-amber-700">
          This doctor signed an earlier version of the agreement - please review and re-sign the current version.
        </p>
      )}
      <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-line rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
        {AGREEMENT_TEXT}
      </div>

      <div className="mt-3">
        <label className="text-sm font-semibold text-slate-700">Doctor's full name (signature)</label>
        <input
          type="text"
          value={signatureName}
          onChange={(e) => setSignatureName(e.target.value)}
          placeholder="Type full name to sign"
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
        I have read and agree to the terms above.
      </label>

      <div className="mt-3">
        <label className="text-sm font-semibold text-slate-700">Physically-signed copy (optional)</label>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,application/pdf" className="mt-1 block w-full text-xs" />
        <p className="mt-1 text-xs text-slate-400">JPG, PNG, or PDF, up to 10MB.</p>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <Button onClick={submit} disabled={saving} className="mt-3" full>
        {saving ? 'Signing...' : 'Sign agreement'}
      </Button>
    </div>
  );
}
