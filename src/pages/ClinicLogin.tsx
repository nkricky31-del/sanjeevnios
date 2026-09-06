import { ArrowRight, Building2, FileCheck2, Lock, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import BrandMark from '../components/ui/BrandMark';
import Button from '../components/ui/Button';
import { setActingMode } from '../lib/actingMode';
import { CLINIC_SIGNUP_INTENT_KEY } from '../lib/clinicSignupIntent';
import { safeNext } from '../lib/loginRedirect';
import { livePhoneDigits, normalizePhone } from '../lib/phone';
import { supabase } from '../lib/supabaseClient';

const TRUST_BADGES = [
  { icon: ShieldCheck, lines: ['Secure &', 'Encrypted'] },
  { icon: FileCheck2, lines: ['Admin', 'Verified'] },
  { icon: Lock, lines: ['Clinic Data', 'Isolated'] },
];

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

    const { error: sendError } = await supabase.auth.signInWithOtp({ phone });
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
    <div className="relative min-h-screen overflow-hidden bg-canvas">
      {/* Coral wash instead of PatientLogin's lavender one - same brand mark,
          deliberately different accent so this never reads as the patient screen. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-32 h-72 bg-coral-100/50 [mask-image:radial-gradient(120%_60%_at_50%_0%,#000_40%,transparent_75%)]"
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-md flex-col px-5 pb-10 pt-12">
        <div className="flex flex-col items-center text-center">
          <BrandMark size={64} />
          <h1 className="mt-3 text-2xl font-extrabold tracking-tight text-brand-600">SanjeevniOS</h1>
          <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-coral-50 px-3 py-1 text-xs font-bold text-coral-600">
            <Building2 size={13} /> Clinic Console
          </p>
        </div>

        <div className="mt-7 rounded-3xl border border-slate-100 bg-white p-5 shadow-sm shadow-slate-200/60">
          {stage === 'details' ? (
            <>
              <h2 className="text-2xl font-extrabold text-slate-900">
                {mode === 'register' ? 'Register your clinic' : 'Clinic Login'}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {mode === 'register'
                  ? 'Sign in with your phone number to get started'
                  : 'Sign in with your Clinic ID and registered phone number'}
              </p>

              <form onSubmit={sendOtp} className="mt-4">
                {mode === 'login' && (
                  <div className="mb-4">
                    <label className="text-sm font-bold text-slate-800">Clinic ID</label>
                    <input
                      type="text"
                      value={clinicId}
                      onChange={(e) => setClinicId(e.target.value)}
                      placeholder="e.g. SNJ-CL-000123"
                      className="mt-1.5 w-full rounded-2xl border border-slate-200 bg-white px-3.5 py-3.5 text-sm font-medium outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-coral-500"
                    />
                  </div>
                )}

                <label className="text-sm font-bold text-slate-800">Registered Mobile Number</label>
                <div className="mt-1.5 flex items-center overflow-hidden rounded-2xl border border-slate-200 bg-white focus-within:ring-2 focus-within:ring-coral-500">
                  <span className="flex items-center gap-2 border-r border-slate-200 px-3 py-3.5 text-sm font-bold text-slate-700">
                    <span aria-hidden className="flex h-3.5 w-5 flex-col overflow-hidden rounded-sm ring-1 ring-slate-200">
                      <span className="flex-1 bg-[#FF9933]" />
                      <span className="flex flex-1 items-center justify-center bg-white">
                        <span className="h-1 w-1 rounded-full ring-[0.5px] ring-[#128807]" />
                      </span>
                      <span className="flex-1 bg-[#128807]" />
                    </span>
                    +91
                  </span>
                  <input
                    type="tel"
                    inputMode="numeric"
                    maxLength={15}
                    value={digits}
                    onChange={(e) => setDigits(livePhoneDigits(e.target.value))}
                    placeholder="Enter clinic's mobile number"
                    className="w-full bg-transparent px-3 py-3.5 text-sm font-medium outline-none placeholder:text-slate-400"
                  />
                </div>

                {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

                <Button type="submit" variant="coral" disabled={loading} full className="mt-4">
                  {loading ? 'Sending...' : 'Continue'}
                  {!loading && <ArrowRight size={17} />}
                </Button>
              </form>

              {mode === 'login' && (
                <p className="mt-3 text-center text-xs text-slate-400">
                  Don't have a Clinic ID yet?{' '}
                  <button type="button" onClick={switchToRegister} className="font-bold text-coral-600">
                    Register your clinic
                  </button>
                </p>
              )}

              <div className="mt-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-slate-100" />
                <span className="text-xs text-slate-400">or</span>
                <span className="h-px flex-1 bg-slate-100" />
              </div>

              <p className="text-center text-sm text-slate-500">
                {mode === 'register' ? (
                  <button type="button" onClick={switchToLogin} className="font-bold text-coral-600">
                    Go back to Clinic Login
                  </button>
                ) : (
                  <>
                    Not a clinic?{' '}
                    <Link to="/login" className="font-bold text-coral-600">
                      Patient login
                    </Link>
                  </>
                )}
              </p>
            </>
          ) : (
            <form onSubmit={verifyOtp}>
              <h2 className="text-2xl font-extrabold text-slate-900">Verify your number</h2>
              <p className="mt-1 text-sm text-slate-500">
                Enter the 6-digit code sent to <span className="font-semibold text-slate-700">+91 {digits}</span>
              </p>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                placeholder="······"
                className="mt-4 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3.5 text-center text-2xl font-extrabold tracking-[0.4em] outline-none focus:ring-2 focus:ring-coral-500"
              />
              {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
              <Button type="submit" variant="coral" disabled={loading} full className="mt-4">
                {loading ? 'Verifying...' : 'Verify & sign in'}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setStage('details');
                  setOtp('');
                  setError(null);
                }}
                className="mt-3 w-full text-center text-sm font-semibold text-slate-500"
              >
                Use a different number
              </button>
            </form>
          )}
        </div>

        <div className="mt-6 grid grid-cols-3 gap-2 text-center">
          {TRUST_BADGES.map((b) => (
            <div key={b.lines.join()} className="flex flex-col items-center gap-1.5">
              <b.icon size={20} className="text-coral-600" />
              <p className="text-[11px] font-semibold leading-tight text-slate-500">
                {b.lines[0]}
                <br />
                {b.lines[1]}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
