import { ArrowLeft, Maximize2, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import QrCode from '../components/ui/QrCode';
import { useAuth } from '../lib/AuthContext';
import { issueClinicCheckinCode } from '../lib/checkIn';
import { supabase } from '../lib/supabaseClient';

// Re-mint comfortably inside the 3-minute rotation so the code on screen is
// always the current one.
const REFRESH_MS = 60 * 1000;

// The screen reception puts on a tablet or monitor facing the waiting room,
// for clinics that have turned self check-in on. Patients scan it from their
// own app to check themselves in.
//
// Deliberately a SCREEN, not a printed poster: the whole reason this is safe
// is that the code rotates every few minutes, so a photo taken yesterday (or
// sent to a friend at home) is refused. A printed sheet would be a permanent
// code, which is exactly what the rotation exists to prevent.
export default function ClinicPoster() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [clinic, setClinic] = useState<{ id: string; name: string; self_checkin_enabled: boolean } | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profile) return;
    supabase
      .from('clinics')
      .select('id, name, self_checkin_enabled')
      .eq('owner_id', profile.id)
      .maybeSingle()
      .then(({ data }) => {
        setClinic(data as typeof clinic);
        setLoading(false);
      });
  }, [profile]);

  // Pulled out so the callback below depends on a plain string rather than
  // the clinic object - otherwise the memo is re-created on every load and
  // the interval below gets torn down and rebuilt with it.
  const clinicId = clinic?.id ?? null;

  const refresh = useCallback(async () => {
    if (!clinicId) return;
    const result = await issueClinicCheckinCode(clinicId);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setCode(result.code);
  }, [clinicId]);

  useEffect(() => {
    if (!clinicId) return;
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [clinicId, refresh]);

  const goFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };

  if (loading) return <p className="p-6 text-slate-400">Loading...</p>;

  return (
    <div className="min-h-screen bg-white">
      <div className="flex items-center justify-between px-6 py-4">
        <button
          onClick={() => navigate('/')}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-400 hover:text-slate-700"
        >
          <ArrowLeft size={16} /> Back to console
        </button>
        <button
          onClick={goFullscreen}
          aria-label="Toggle fullscreen"
          className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <Maximize2 size={18} />
        </button>
      </div>

      <div className="mx-auto flex max-w-2xl flex-col items-center px-6 pb-12 text-center">
        {!clinic ? (
          <p className="mt-20 text-slate-400">No clinic found for this account.</p>
        ) : !clinic.self_checkin_enabled ? (
          <div className="mt-20 max-w-md rounded-3xl bg-amber-50 p-6 text-amber-800">
            <p className="text-lg font-bold">Self check-in is switched off</p>
            <p className="mt-2 text-sm leading-relaxed">
              Patients can't check themselves in at this clinic, so this code won't work. Turn it on with:
            </p>
            <code className="mt-3 block rounded-xl bg-white/70 p-3 text-left text-xs">
              update clinics set self_checkin_enabled = true where id = '{clinic.id}';
            </code>
          </div>
        ) : (
          <>
            <h1 className="mt-4 text-4xl font-extrabold tracking-tight text-slate-900">Scan to check in</h1>
            <p className="mt-2 text-lg text-slate-500">{clinic.name}</p>

            <div className="mt-8">
              {code ? (
                <QrCode value={code} size={340} className="ring-4 ring-brand-100" alt="Clinic check-in code" />
              ) : (
                <div className="flex h-[340px] w-[340px] items-center justify-center rounded-2xl bg-slate-50 text-slate-400">
                  {error ?? 'Preparing code...'}
                </div>
              )}
            </div>

            <ol className="mt-8 space-y-2 text-left text-lg text-slate-600">
              <li>
                <span className="font-bold text-brand-600">1.</span> Open SanjeevniOS and go to today's
                appointment.
              </li>
              <li>
                <span className="font-bold text-brand-600">2.</span> Tap <strong>Scan reception code to check
                in</strong>.
              </li>
              <li>
                <span className="font-bold text-brand-600">3.</span> Point your camera at this code — your token
                appears straight away.
              </li>
            </ol>

            <p className="mt-8 flex items-center gap-2 text-sm text-slate-400">
              <ShieldCheck size={15} />
              This code changes every few minutes — a photo of it won't work later.
            </p>

            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
