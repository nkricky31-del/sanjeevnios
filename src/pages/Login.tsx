import { ArrowRight, Lock, ShieldCheck, UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import BrandMark from '../components/ui/BrandMark';
import Button from '../components/ui/Button';
import Segmented from '../components/ui/Segmented';
import { CLINIC_SIGNUP_INTENT_KEY } from '../lib/clinicSignupIntent';
import { livePhoneDigits } from '../lib/phone';
import { supabase } from '../lib/supabaseClient';

const TRUST_BADGES = [
  { icon: ShieldCheck, lines: ['Secure &', 'Encrypted'] },
  { icon: UserRound, lines: ['DPDP', 'Compliant'] },
  { icon: Lock, lines: ['Your Privacy', 'Our Priority'] },
];

export default function Login() {
  const [stage, setStage] = useState<'phone' | 'otp'>('phone');
  const [intent, setIntent] = useState<'patient' | 'clinic'>('patient');
  const [method, setMethod] = useState<'mobile' | 'mrn'>('mobile');
  const [digits, setDigits] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phone = `+91${digits}`;

  // Read by App.tsx right after login: if this account turns out to be a
  // fresh patient (not already 'clinic'/'admin'), it sends them to the
  // clinic registration form instead of the normal patient home screen.
  // Same phone+OTP login either way - this only decides where they land.
  const chooseClinicSignup = () => {
    setIntent('clinic');
    sessionStorage.setItem(CLINIC_SIGNUP_INTENT_KEY, '1');
    setError(null);
  };

  const choosePatientLogin = () => {
    setIntent('patient');
    sessionStorage.removeItem(CLINIC_SIGNUP_INTENT_KEY);
    setError(null);
  };

  const sendOtp = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (digits.length !== 10) {
      setError('Enter a 10-digit phone number.');
      return;
    }
    setLoading(true);
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
    }
    // On success, AuthProvider's onAuthStateChange picks up the new session automatically.
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-canvas">
      {/* The soft lavender wave the mockup's login sits on. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-32 h-72 bg-brand-100/50 [mask-image:radial-gradient(120%_60%_at_50%_0%,#000_40%,transparent_75%)]"
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-md flex-col px-5 pb-10 pt-12">
        <div className="flex flex-col items-center text-center">
          <BrandMark size={72} />
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-brand-600">SanjeevniOS</h1>
          <p className="mt-1 text-sm text-slate-500">Your Health, Our Priority</p>
        </div>

        <div className="mt-7 rounded-3xl border border-slate-100 bg-white p-5 shadow-sm shadow-slate-200/60">
          {stage === 'phone' ? (
            <>
              <h2 className="text-2xl font-extrabold text-slate-900">
                {intent === 'clinic' ? 'Register your clinic' : 'Welcome Back!'}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {intent === 'clinic'
                  ? 'Sign in with your phone number to get started'
                  : 'Login to continue to your account'}
              </p>

              <div className="mt-4">
                <Segmented
                  options={[
                    { value: 'mobile', label: 'Login with Mobile' },
                    { value: 'mrn', label: 'Login with MRN' },
                  ]}
                  value={method}
                  onChange={setMethod}
                />
              </div>

              {method === 'mrn' ? (
                <div className="mt-4 rounded-2xl bg-brand-50 p-3.5 text-xs leading-relaxed text-slate-600">
                  <p className="text-sm font-bold text-brand-700">Sign in with your mobile number</p>
                  <p className="mt-1">
                    Your MRN is linked to the mobile number you gave the clinic — sign in with that number and every
                    record filed under your MRN, at any Sanjeevni clinic, appears automatically.
                  </p>
                  <button
                    onClick={() => setMethod('mobile')}
                    className="mt-2 text-sm font-bold text-brand-600"
                    type="button"
                  >
                    Use mobile number →
                  </button>
                </div>
              ) : (
                <form onSubmit={sendOtp} className="mt-4">
                  <label className="text-sm font-bold text-slate-800">Mobile Number</label>
                  <div className="mt-1.5 flex items-center overflow-hidden rounded-2xl border border-slate-200 bg-white focus-within:ring-2 focus-within:ring-brand-500">
                    <span className="flex items-center gap-2 border-r border-slate-200 px-3 py-3.5 text-sm font-bold text-slate-700">
                      {/* Drawn rather than the 🇮🇳 emoji, which falls back to
                          the letters "IN" on Windows. */}
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
                      placeholder="Enter your mobile number"
                      className="w-full bg-transparent px-3 py-3.5 text-sm font-medium outline-none placeholder:text-slate-400"
                    />
                  </div>

                  {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

                  <Button type="submit" disabled={loading} full className="mt-4">
                    {loading ? 'Sending...' : 'Continue'}
                    {!loading && <ArrowRight size={17} />}
                  </Button>
                </form>
              )}

              <div className="mt-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-slate-100" />
                <span className="text-xs text-slate-400">or</span>
                <span className="h-px flex-1 bg-slate-100" />
              </div>

              <p className="mt-4 text-center text-sm text-slate-500">
                {intent === 'patient' ? 'Are you a clinic?' : 'Signing in as a patient?'}{' '}
                <button
                  type="button"
                  onClick={intent === 'patient' ? chooseClinicSignup : choosePatientLogin}
                  className="font-bold text-brand-600"
                >
                  {intent === 'patient' ? 'Register here' : 'Go back'}
                </button>
              </p>
              <p className="mt-1 text-center text-xs text-slate-400">
                New to SanjeevniOS? Just continue — your account is created on first sign-in.
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
                className="mt-4 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3.5 text-center text-2xl font-extrabold tracking-[0.4em] outline-none focus:ring-2 focus:ring-brand-500"
              />
              {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
              <Button type="submit" disabled={loading} full className="mt-4">
                {loading ? 'Verifying...' : 'Verify & sign in'}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setStage('phone');
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

        <div className="mt-5 flex items-start gap-3 rounded-2xl bg-brand-50 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-brand-600">
            <ShieldCheck size={19} />
          </span>
          <div>
            <p className="text-sm font-bold text-brand-700">Your data is safe with us</p>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-600">
              We use industry-standard encryption to keep your information secure.
            </p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-2 text-center">
          {TRUST_BADGES.map((b) => (
            <div key={b.lines.join()} className="flex flex-col items-center gap-1.5">
              <b.icon size={20} className="text-brand-600" />
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
