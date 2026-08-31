import { ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { EMERGENCY_NOTE, PATIENT_DECLARATION_TEXT } from '../lib/platformDisclaimer';
import { usePatientDeclarationStatus } from '../lib/usePatientDeclaration';
import Button from './ui/Button';
import Card from './ui/Card';

interface Props {
  children: ReactNode;
}

// Wraps the whole patient app (see App.tsx) - blocks entry until the
// current declaration_version is accepted. Since this re-checks on every
// mount rather than "only the very first login ever", it naturally also
// covers a later wording change (PATIENT_DECLARATION_VERSION bump): any
// patient who accepted an older version sees this again next time they open
// the app, not just brand-new signups.
export default function PatientDeclarationGate({ children }: Props) {
  const { status, accept } = usePatientDeclarationStatus();
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  }

  if (status === 'accepted') return <>{children}</>;

  const submit = async () => {
    setError(null);
    if (!agreed) {
      setError('Please tick the box to continue.');
      return;
    }
    setSaving(true);
    const err = await accept();
    setSaving(false);
    if (err) setError(err);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-50 via-slate-50 to-coral-50 px-4 py-8">
      <Card className="w-full max-w-sm !rounded-3xl !p-6">
        <p className="text-lg font-bold text-slate-900">Before you continue</p>
        <p className="mt-1 text-sm text-slate-500">Please read and accept this declaration.</p>

        <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-600">
          {PATIENT_DECLARATION_TEXT}
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs font-medium text-amber-800">
          <ShieldAlert size={15} className="mt-0.5 shrink-0" />
          {EMERGENCY_NOTE}
        </div>

        <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
          I have read and understood this.
        </label>

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <Button onClick={submit} disabled={saving} full className="mt-4">
          {saving ? 'Saving...' : 'Accept and continue'}
        </Button>
      </Card>
    </div>
  );
}
