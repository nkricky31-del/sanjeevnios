import { ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { DPDP_CONSENT_TEXT } from '../lib/dpdpConsent';
import { EMERGENCY_NOTE, PATIENT_DECLARATION_TEXT } from '../lib/platformDisclaimer';
import { useDpdpConsentStatus, usePatientDeclarationStatus } from '../lib/usePatientConsent';
import Button from './ui/Button';
import Card from './ui/Card';

interface Props {
  children: ReactNode;
}

// Wraps the whole patient app (see App.tsx) - blocks entry until BOTH
// consents are accepted at their current version: the platform declaration
// ("we're a booking platform, not a care provider") and the DPDP data
// consent (handling personal/health data), tracked as two entirely separate
// rows (see schema.sql section 22) with two separate checkboxes below, per
// spec - accepting one is never treated as accepting the other. Since this
// re-checks on every mount rather than "only the very first login ever", it
// naturally also covers a later wording change on either one: a patient who
// accepted an older version of just ONE of them only sees that one's
// checkbox again, not both.
export default function PatientDeclarationGate({ children }: Props) {
  const platform = usePatientDeclarationStatus();
  const dpdp = useDpdpConsentStatus();
  const [platformAgreed, setPlatformAgreed] = useState(false);
  const [dpdpAgreed, setDpdpAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (platform.status === 'loading' || dpdp.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  }

  if (platform.status === 'accepted' && dpdp.status === 'accepted') return <>{children}</>;

  const submit = async () => {
    setError(null);
    if (platform.status === 'needed' && !platformAgreed) {
      setError('Please tick both boxes to continue.');
      return;
    }
    if (dpdp.status === 'needed' && !dpdpAgreed) {
      setError('Please tick both boxes to continue.');
      return;
    }
    setSaving(true);
    if (platform.status === 'needed') {
      const err = await platform.accept();
      if (err) {
        setSaving(false);
        setError(err);
        return;
      }
    }
    if (dpdp.status === 'needed') {
      const err = await dpdp.accept();
      if (err) {
        setSaving(false);
        setError(err);
        return;
      }
    }
    setSaving(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-50 via-slate-50 to-coral-50 px-4 py-8">
      <Card className="w-full max-w-sm !rounded-3xl !p-6">
        <p className="text-lg font-bold text-slate-900">Before you continue</p>
        <p className="mt-1 text-sm text-slate-500">Please read and accept the following.</p>

        {platform.status === 'needed' && (
          <div className="mt-3">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Platform declaration</p>
            <div className="mt-1 rounded-xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-600">
              {PATIENT_DECLARATION_TEXT}
            </div>
            <label className="mt-2 flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={platformAgreed}
                onChange={(e) => setPlatformAgreed(e.target.checked)}
                className="mt-0.5"
              />
              I have read and understood this.
            </label>
          </div>
        )}

        {dpdp.status === 'needed' && (
          <div className="mt-4">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Data-sharing consent</p>
            <div className="mt-1 rounded-xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-600">
              {DPDP_CONSENT_TEXT}
            </div>
            <label className="mt-2 flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={dpdpAgreed}
                onChange={(e) => setDpdpAgreed(e.target.checked)}
                className="mt-0.5"
              />
              I consent to this.
            </label>
          </div>
        )}

        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs font-medium text-amber-800">
          <ShieldAlert size={15} className="mt-0.5 shrink-0" />
          {EMERGENCY_NOTE}
        </div>

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <Button onClick={submit} disabled={saving} full className="mt-4">
          {saving ? 'Saving...' : 'Accept and continue'}
        </Button>
      </Card>
    </div>
  );
}
