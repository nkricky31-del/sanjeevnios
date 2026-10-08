import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import {
  AuthDivider, AuthError, AuthHeading, AuthLink, AuthLinkButton, AuthSubmit, AuthTextButton, OtpField, PhoneField, TextField,
} from '../components/auth/AuthFields';
import AuthShell from '../components/auth/AuthShell';
import { setActingMode } from '../lib/actingMode';
import { CLINIC_SIGNUP_INTENT_KEY } from '../lib/clinicSignupIntent';
import { safeNext } from '../lib/loginRedirect';
import { normalizePhone } from '../lib/phone';
import { logAuthEvent } from '../lib/audit';
import { supabase } from '../lib/supabaseClient';
import { CAPTCHA_ENABLED } from '../lib/captcha';
import TurnstileWidget from '../components/TurnstileWidget';

// The CLINIC login screen - its own URL, its own (coral-accented) look, so
// it's never confused with the patient screen. An EXISTING clinic signs in
// with its Clinic ID + a phone number registered to that clinic, then OTP.
// A brand-new clinic that doesn't have an ID yet uses "New clinic? Register
// here" instead, which is the same phone -> OTP flow PatientLogin uses, just
// flagged (via CLINIC_SIGNUP_INTENT_KEY) so App.tsx sends a fresh account to
// ClinicSignup.tsx instead of the patient home screen.
//
// The Clinic ID + phone pair is checked server-side by verify_clinic_login()
// (supabase/migration_57_clinic_login_id.sql) BEFORE any OTP is sent - only
// a pair that names the SAME approved clinic gets one. This is a real gate,
// not just a UI step: it's a SECURITY DEFINER RPC granted to anon, so it
// runs the identical check no matter how it's called, and nothing downstream
// ever trusts the client's own claim of which clinic it is - every table's
// RLS still runs off auth.uid() from the OTP-verified session, same as
// before this existed.
export default function ClinicLogin() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [stage, setStage] = useState<'details' | 'otp'>('details');
  const [clinicId, setClinicId] = useState('');
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

  // Marketing site's "Join us — Register your clinic" CTAs (MarketingNav /
  // MarketingHome / ForClinics / MarketingFooter) link straight to
  // ?mode=register so a brand-new clinic never sees the Clinic ID field.
  useEffect(() => {
    if (searchParams.get('mode') === 'register') {
      setMode('register');
      sessionStorage.setItem(CLINIC_SIGNUP_INTENT_KEY, '1');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchToRegister = () => {
    setMode('register');
    sessionStorage.setItem(CLINIC_SIGNUP_INTENT_KEY, '1');
    setError(null);
  };

  const switchToLogin = () => {
    setMode('login');
    sessionStorage.removeItem(CLINIC_SIGNUP_INTENT_KEY);
    setError(null);
  };

  const sendOtp = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === 'login' && !clinicId.trim()) {
      setError('Enter your Clinic ID.');
      return;
    }
    if (digits.length !== 10) {
      setError('Enter a 10-digit phone number.');
      return;
    }

    // Set BEFORE the OTP round trip (both sub-modes - a fresh registration
    // is clinic intent too), same reasoning as PatientLogin.tsx: this
    // account might already be a patient on this same phone (migration 57),
    // and App.tsx needs "clinic" already recorded the instant a session
    // exists, whichever order that ends up racing AuthContext's own
    // auth-state listener in. See actingMode.ts.
    setActingMode('clinic');
    setLoading(true);

    // 'register' mode (a brand-new clinic with no ID yet) skips this check
    // entirely - there's nothing to verify against until it's approved.
    if (mode === 'login') {
      const normalizedPhone = normalizePhone(digits);
      const { data: verified, error: verifyError } = await supabase.rpc('verify_clinic_login', {
        p_clinic_code: clinicId.trim(),
        p_phone: normalizedPhone,
      });
      if (verifyError) {
        setLoading(false);
        setError('Could not verify right now - please try again.');
        return;
      }
      if (!verified) {
        setLoading(false);
        // Deliberately generic - never says which half (Clinic ID vs phone)
        // was wrong, matching verify_clinic_login()'s own refusal to
        // distinguish the two server-side.
        setError("That Clinic ID and phone number don't match an approved clinic.");
        return;
      }
    }

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
    // Same handoff as PatientLogin - App.tsx's onAuthStateChange-driven
    // re-render decides where this account actually lands (clinic console,
    // or ClinicSignup.tsx if mode === 'register' flagged a fresh account).
    navigate(next, { replace: true });
  };

  return (
    <AuthShell role="clinic">
      {stage === 'details' ? (
        <>
          <AuthHeading
            title={mode === 'register' ? 'Register your clinic' : 'Clinic login'}
            sub={
              mode === 'register'
                ? 'Sign in with your phone number to get started.'
                : 'Sign in with your Clinic ID and registered phone number.'
            }
          />

          <form onSubmit={sendOtp} className="mt-6 space-y-4">
            {mode === 'login' && (
              <TextField label="Clinic ID" value={clinicId} onChange={setClinicId} placeholder="e.g. SNJ-CL-000123" />
            )}
            <PhoneField
              label="Registered mobile number"
              value={digits}
              onChange={setDigits}
              placeholder="Clinic's mobile number"
            />
            {error && <AuthError>{error}</AuthError>}
            <TurnstileWidget onToken={setCaptchaToken} resetSignal={captchaReset} theme="dark" />
            <AuthSubmit loading={loading} loadingLabel="Sending..." disabled={loading || (CAPTCHA_ENABLED && !captchaToken)}>
              Continue
            </AuthSubmit>
          </form>

          {mode === 'login' && (
            <p className="mt-4 text-center text-xs text-ink-2">
              Don't have a Clinic ID yet? <AuthLinkButton onClick={switchToRegister}>Register your clinic</AuthLinkButton>
            </p>
          )}

          <AuthDivider />
          <p className="text-center text-sm text-ink-2">
            {mode === 'register' ? (
              <AuthLinkButton onClick={switchToLogin}>Go back to clinic login</AuthLinkButton>
            ) : (
              <>
                Not a clinic? <AuthLink to="/login">Patient login</AuthLink>
              </>
            )}
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
              setStage('details');
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
