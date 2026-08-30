import { Stethoscope } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { CLINIC_SIGNUP_INTENT_KEY } from '../lib/clinicSignupIntent';
import { supabase } from '../lib/supabaseClient';

export default function Login() {
  const [stage, setStage] = useState<'phone' | 'otp'>('phone');
  const [intent, setIntent] = useState<'patient' | 'clinic'>('patient');
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
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-50 via-slate-50 to-coral-50 px-4">
      <Card className="w-full max-w-sm !rounded-3xl !p-8">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-lg shadow-brand-600/30">
            <Stethoscope size={26} />
          </div>
          <p className="mt-3 text-xl font-extrabold text-slate-900">
            {intent === 'clinic' ? 'Register your clinic' : 'SanjeevniOS'}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {intent === 'clinic' ? 'Sign in with your phone number to get started' : 'Sign in with your phone number'}
          </p>
        </div>

        {stage === 'phone' ? (
          <form onSubmit={sendOtp} className="mt-6 space-y-4">
            <div>
              <label className="text-sm font-semibold text-slate-700">Phone number</label>
              <div className="mt-1.5 flex items-center overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 focus-within:ring-2 focus-within:ring-brand-500">
                <span className="border-r border-slate-200 px-3.5 py-3 text-sm font-semibold text-slate-500">+91</span>
                <input
                  type="tel"
                  inputMode="numeric"
                  maxLength={10}
                  value={digits}
                  onChange={(e) => setDigits(e.target.value.replace(/\D/g, ''))}
                  placeholder="9876543210"
                  className="w-full bg-transparent px-3 py-3 text-sm font-medium outline-none"
                />
              </div>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" disabled={loading} full>
              {loading ? 'Sending...' : 'Send code'}
            </Button>
            <button
              type="button"
              onClick={intent === 'patient' ? chooseClinicSignup : choosePatientLogin}
              className="block w-full text-center text-sm font-bold text-coral-600"
            >
              {intent === 'patient' ? 'Are you a clinic? Register here' : '← Back to patient login'}
            </button>
          </form>
        ) : (
          <form onSubmit={verifyOtp} className="mt-6 space-y-4">
            <div>
              <label className="text-sm font-semibold text-slate-700">6-digit code sent to +91{digits}</label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                className="mt-1.5 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-center text-lg font-bold tracking-[0.5em] outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" disabled={loading} full>
              {loading ? 'Verifying...' : 'Verify & sign in'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              full
              onClick={() => {
                setStage('phone');
                setOtp('');
                setError(null);
              }}
            >
              Use a different number
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
