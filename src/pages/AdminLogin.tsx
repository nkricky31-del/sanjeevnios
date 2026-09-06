import { ArrowLeft, ArrowRight, Lock, ShieldAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import BrandMark from '../components/ui/BrandMark';
import Button from '../components/ui/Button';
import { safeNext } from '../lib/loginRedirect';
import { livePhoneDigits } from '../lib/phone';
import { supabase } from '../lib/supabaseClient';

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
    navigate(next, { replace: true });
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-slate-800/40 [mask-image:radial-gradient(120%_60%_at_50%_0%,#000_40%,transparent_75%)]"
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-md flex-col px-5 pb-10 pt-12">
        <div className="flex flex-col items-center text-center">
          <BrandMark size={56} />
          <h1 className="mt-3 text-xl font-extrabold tracking-tight text-white">SanjeevniOS</h1>
          <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-slate-200">
            <ShieldAlert size={13} /> Admin
          </p>
        </div>

        <div className="mt-7 rounded-3xl border border-white/10 bg-slate-900 p-5 shadow-lg shadow-black/30">
          {stage === 'phone' ? (
            <>
              <h2 className="text-2xl font-extrabold text-white">Admin Login</h2>
              <p className="mt-1 text-sm text-slate-400">Sign in with your registered phone number</p>

              <form onSubmit={sendOtp} className="mt-4">
                <label className="text-sm font-bold text-slate-200">Mobile Number</label>
                <div className="mt-1.5 flex items-center overflow-hidden rounded-2xl border border-white/10 bg-slate-950 focus-within:ring-2 focus-within:ring-slate-500">
                  <span className="border-r border-white/10 px-3 py-3.5 text-sm font-bold text-slate-300">+91</span>
                  <input
                    type="tel"
                    inputMode="numeric"
                    maxLength={15}
                    value={digits}
                    onChange={(e) => setDigits(livePhoneDigits(e.target.value))}
                    placeholder="Enter your mobile number"
                    className="w-full bg-transparent px-3 py-3.5 text-sm font-medium text-white outline-none placeholder:text-slate-500"
                  />
                </div>

                {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

                <Button type="submit" variant="dark" disabled={loading} full className="mt-4">
                  {loading ? 'Sending...' : 'Continue'}
                  {!loading && <ArrowRight size={17} />}
                </Button>
              </form>
            </>
          ) : (
            <form onSubmit={verifyOtp}>
              <h2 className="text-2xl font-extrabold text-white">Verify your number</h2>
              <p className="mt-1 text-sm text-slate-400">
                Enter the 6-digit code sent to <span className="font-semibold text-slate-200">+91 {digits}</span>
              </p>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                placeholder="······"
                className="mt-4 w-full rounded-2xl border border-white/10 bg-slate-950 px-3 py-3.5 text-center text-2xl font-extrabold tracking-[0.4em] text-white outline-none focus:ring-2 focus:ring-slate-500"
              />
              {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
              <Button type="submit" variant="dark" disabled={loading} full className="mt-4">
                {loading ? 'Verifying...' : 'Verify & sign in'}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setStage('phone');
                  setOtp('');
                  setError(null);
                }}
                className="mt-3 w-full text-center text-sm font-semibold text-slate-400"
              >
                Use a different number
              </button>
            </form>
          )}
        </div>

        <div className="mt-5 flex items-center gap-2 rounded-2xl bg-white/5 p-3.5 text-xs text-slate-400">
          <Lock size={15} className="shrink-0" />
          Restricted access. Every action here is logged.
        </div>

        <p className="mt-6 text-center">
          <Link to="/login" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
            <ArrowLeft size={12} /> Back to patient login
          </Link>
        </p>
      </div>
    </div>
  );
}
