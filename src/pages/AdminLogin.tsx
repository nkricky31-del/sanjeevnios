import { ArrowLeft, Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import {
  AuthError, AuthHeading, AuthNotice, AuthSubmit, AuthTextButton, OtpField, PhoneField,
} from '../components/auth/AuthFields';
import AuthShell from '../components/auth/AuthShell';
import { safeNext } from '../lib/loginRedirect';
import { logAuthEvent } from '../lib/audit';
import { supabase } from '../lib/supabaseClient';
import { CAPTCHA_ENABLED } from '../lib/captcha';
import TurnstileWidget from '../components/TurnstileWidget';

// The ADMIN login screen - its own URL, its own dark/neutral look (never
// brand-violet or clinic-coral, so it never reads as either of those).
// Phone + OTP only, same as PatientLogin - no MRN, no Clinic ID. There's no
// separate admin signup: an account only ever lands in AdminConsole because
// its profiles.role is already 'admin' (set directly in the database), so
// this screen doesn't need to collect or check anything beyond identity -
// App.tsx's role check after sign-in decides whether AdminConsole is
// actually reachable.
export default function AdminLogin() {
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

  const sendOtp = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (digits.length !== 10) {
      setError('Enter a 10-digit phone number.');
      return;
    }
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
    navigate(next, { replace: true });
  };

  return (
    <AuthShell
      role="admin"
      aside={
        <Link to="/login" className="inline-flex items-center gap-1 text-muted hover:text-ink-2">
          <ArrowLeft size={12} /> Back to patient login
        </Link>
      }
    >
      {stage === 'phone' ? (
        <>
          <AuthNotice icon={Lock}>Restricted access. Every action here is logged.</AuthNotice>
          <AuthHeading title="Admin login" sub="Sign in with your registered phone number. You will be asked for your authenticator app next." />

          <form onSubmit={sendOtp} className="mt-6">
            <PhoneField label="Mobile number" value={digits} onChange={setDigits} placeholder="Enter your mobile number" />
            {error && <AuthError>{error}</AuthError>}
            <TurnstileWidget onToken={setCaptchaToken} resetSignal={captchaReset} theme="light" />
            <AuthSubmit loading={loading} loadingLabel="Sending..." disabled={loading || (CAPTCHA_ENABLED && !captchaToken)}>
              Continue
            </AuthSubmit>
          </form>
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
