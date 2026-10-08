import { LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import {
  AuthDivider, AuthError, AuthHeading, AuthLink, AuthNotice, AuthSubmit, AuthTextButton, OtpField, PhoneField,
} from '../components/auth/AuthFields';
import AuthShell from '../components/auth/AuthShell';
import { setActingMode } from '../lib/actingMode';
import { safeNext } from '../lib/loginRedirect';
import { logAuthEvent } from '../lib/audit';
import { supabase } from '../lib/supabaseClient';
import { CAPTCHA_ENABLED } from '../lib/captcha';
import TurnstileWidget from '../components/TurnstileWidget';

// The PATIENT login screen - phone number, then OTP, nothing else. No MRN
// field: MRN is a record number shown inside a patient's profile once
// they're already signed in (schema.sql section 18), never a login
// credential. Clinics and admins have their own separate screens
// (ClinicLogin.tsx / AdminLogin.tsx) reachable from the links at the
// bottom of this one - see App.tsx for how each role is routed here.
export default function PatientLogin() {
  const [stage, setStage] = useState<'phone' | 'otp'>('phone');
  const [digits, setDigits] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  const phone = `+91${digits}`;

  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(searchParams.get('next'));
  const cameFromPrivatePage = next !== '/';

  const sendOtp = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (digits.length !== 10) {
      setError('Enter a 10-digit phone number.');
      return;
    }
    // Set BEFORE the OTP round trip, not after verifyOtp succeeds - this
    // account might also be clinic staff on this same phone (migration 57),
    // and App.tsx needs to already know "patient" was explicitly chosen the
    // instant a session exists, however AuthContext's own auth-state
    // listener happens to interleave with this function. See actingMode.ts.
    setActingMode('patient');
    setLoading(true);
    const { error: sendError } = await supabase.auth.signInWithOtp({
      phone,
      options: { captchaToken: captchaToken ?? undefined },
    });
    // A Turnstile token works once - get a fresh one for any retry.
    setCaptchaToken(null);
    setCaptchaReset((n) => n + 1);
    setLoading(false);
    if (sendError) {
      setError(sendError.message);
      return;
    }
    setStage('otp');
  };

  const verifyOtp = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (otp.length !== 6) {
      setError('Enter the 6-digit code.');
      return;
    }
    setLoading(true);
    const { error: verifyError } = await supabase.auth.verifyOtp({ phone, token: otp, type: 'sms' });
    logAuthEvent('otp.verify', verifyError ? 'failure' : 'success', phone);
    setLoading(false);
    if (verifyError) {
      setError(verifyError.message);
      return;
    }
    // AuthProvider's onAuthStateChange picks up the new session automatically
    // (App.tsx re-renders once profile.role is known), but THIS component
    // unmounts the instant that happens, so it can't wait for it - the
    // navigate has to fire right here, synchronously on success. App.tsx's
    // own role check settles the URL further only if `next` turns out to be
    // a page this account's role isn't allowed on.
    navigate(next, { replace: true });
  };

  return (
    <AuthShell
      role="patient"
      aside={
        // Small and understated on purpose - not a role most visitors should
        // be choosing, just a way in for the few who need it.
        <Link to="/admin/login" className="text-muted hover:text-ink-2">
          Admin
        </Link>
      }
    >
      {stage === 'phone' ? (
        <>
          {/* Only for a genuine private-page bounce (App.tsx's ?next=<path>
              redirect) - a clean "please log in" state instead of the visitor
              landing here with no idea why. */}
          {cameFromPrivatePage && <AuthNotice icon={LogIn}>Please log in to continue to that page.</AuthNotice>}
          <AuthHeading title="Welcome back" sub="Sign in to continue to your account." />

          <form onSubmit={sendOtp} className="mt-6">
            <PhoneField label="Mobile number" value={digits} onChange={setDigits} placeholder="Enter your mobile number" />
            {error && <AuthError>{error}</AuthError>}
            <TurnstileWidget onToken={setCaptchaToken} resetSignal={captchaReset} theme="light" />
            <AuthSubmit loading={loading} loadingLabel="Sending..." disabled={loading || (CAPTCHA_ENABLED && !captchaToken)}>
              Continue
            </AuthSubmit>
          </form>

          <AuthDivider />
          <p className="text-center text-sm text-ink-2">
            Are you a clinic? <AuthLink to="/clinic/login">Clinic login</AuthLink>
          </p>
          <p className="mt-2 text-center text-xs leading-relaxed text-muted">
            New to SanjeevniOS? Just continue - your account is created on first sign-in.
          </p>
        </>
      ) : (
        <form onSubmit={verifyOtp}>
          <AuthHeading
            title="Verify your number"
            sub={
              <>
                Enter the 6-digit code sent to <span className="font-semibold text-ink">+91 {digits}</span>
              </>
            }
          />
          <div className="mt-6">
            <OtpField value={otp} onChange={setOtp} />
          </div>
          {error && <AuthError>{error}</AuthError>}
          <AuthSubmit loading={loading} loadingLabel="Verifying..." disabled={loading}>
            Verify &amp; sign in
          </AuthSubmit>
          <AuthTextButton
            onClick={() => {
              setStage('phone');
              setOtp('');
              setError(null);
            }}
          >
            Use a different number
          </AuthTextButton>
        </form>
      )}
    </AuthShell>
  );
}
