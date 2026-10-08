import { ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { supabase } from '../lib/supabaseClient';
import Button from './ui/Button';
import Card from './ui/Card';

// Every internal (admin) account must finish a second step with an
// AUTHENTICATOR APP (TOTP) before the console renders - SMS alone is not
// enough. First sign-in: scan a QR code to enrol. After that: type the
// current 6-digit code. Supabase upgrades the session to assurance level
// "aal2", which the database checks too (migration 78: is_aal2()).
type Phase =
  | { kind: 'loading' }
  | { kind: 'ok' }
  | { kind: 'verify'; factorId: string }
  | { kind: 'enroll'; factorId: string; qr: string; secret: string }
  | { kind: 'error'; message: string };

// Currently OFF. The two-step screen only runs when the build has
// VITE_REQUIRE_ADMIN_MFA=true (set it in Vercel > Settings > Environment
// Variables, then redeploy). To enforce it in the database as well:
//   update guard.settings set value = 'on' where key = 'mfa_required_admin';
// Break-glass access (migration 78) needs the authenticator step either way.
const REQUIRE_ADMIN_MFA = import.meta.env.VITE_REQUIRE_ADMIN_MFA === 'true';

export default function AdminMfaGate({ children }: { children: ReactNode }) {
  if (!REQUIRE_ADMIN_MFA) return <>{children}</>;
  return <MfaGateInner>{children}</MfaGateInner>;
}

function MfaGateInner({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (cancelled) return;
      if (aalError || !aal) {
        setPhase({ kind: 'error', message: aalError?.message ?? 'Could not check your sign-in level.' });
        return;
      }
      if (aal.currentLevel === 'aal2') {
        setPhase({ kind: 'ok' });
        return;
      }
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const verified = factors?.totp?.find((f) => f.status === 'verified');
      if (verified) {
        setPhase({ kind: 'verify', factorId: verified.id });
        return;
      }
      // Drop a half-finished enrolment so a fresh QR can be created.
      for (const f of factors?.all ?? []) {
        if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `SanjeevniOS admin ${new Date().toISOString().slice(0, 10)}`,
      });
      if (cancelled) return;
      if (enrollError || !enrolled) {
        setPhase({ kind: 'error', message: enrollError?.message ?? 'Could not start authenticator setup.' });
        return;
      }
      setPhase({
        kind: 'enroll',
        factorId: enrolled.id,
        qr: enrolled.totp.qr_code,
        secret: enrolled.totp.secret,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (phase.kind !== 'verify' && phase.kind !== 'enroll') return;
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: phase.factorId,
      code,
    });
    setBusy(false);
    if (verifyError) {
      setCode('');
      setError('That code was not accepted. Wait for the next code and try again.');
      return;
    }
    // Refresh so the new token carries aal2 before any admin call is made.
    await supabase.auth.refreshSession();
    setPhase({ kind: 'ok' });
  };

  if (phase.kind === 'ok') return <>{children}</>;

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5">
      <Card>
        <div className="flex items-center gap-2 text-slate-900">
          <ShieldCheck size={22} />
          <h1 className="text-lg font-extrabold">Two-step sign-in</h1>
        </div>

        {phase.kind === 'loading' && <p className="mt-3 text-sm text-slate-500">Checking your sign-in...</p>}

        {phase.kind === 'error' && <p className="mt-3 text-sm text-red-600">{phase.message}</p>}

        {(phase.kind === 'verify' || phase.kind === 'enroll') && (
          <form onSubmit={submit} className="mt-3">
            {phase.kind === 'enroll' ? (
              <>
                <p className="text-sm text-slate-600">
                  Internal accounts need an authenticator app (Google Authenticator, Authy, 1Password...). Scan this
                  code, then enter the 6-digit number it shows.
                </p>
                <img src={phase.qr} alt="Authenticator setup QR code" className="mx-auto mt-3 h-44 w-44" />
                <p className="mt-2 break-all text-center text-xs text-slate-400">
                  Can't scan? Enter this key: <span className="font-mono">{phase.secret}</span>
                </p>
              </>
            ) : (
              <p className="text-sm text-slate-600">Enter the 6-digit code from your authenticator app.</p>
            )}
            <label className="mt-4 block text-sm font-bold text-slate-800" htmlFor="mfa-code">
              Authenticator code
            </label>
            <input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="mt-1.5 w-full rounded-2xl border border-slate-200 px-3 py-3 text-center text-lg tracking-widest outline-none focus:ring-2 focus:ring-brand-500"
            />
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            <Button type="submit" variant="dark" full className="mt-4" disabled={busy}>
              {busy ? 'Checking...' : 'Verify'}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
