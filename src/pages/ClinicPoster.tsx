import Loading from '../components/ui/Loading';
import { ArrowLeft, MapPinOff, Maximize2, Printer, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import Button from '../components/ui/Button';
import QrCode from '../components/ui/QrCode';
import Segmented from '../components/ui/Segmented';
import { useAuth } from '../lib/AuthContext';
import { issueClinicCheckinCode, issueClinicStaticCode, rotateClinicStaticCode } from '../lib/checkIn';
import { supabase } from '../lib/supabaseClient';

// Re-mint comfortably inside the 3-minute rotation so the code on screen is
// always the current one.
const REFRESH_MS = 60 * 1000;

type PosterMode = 'print' | 'screen';

// The clinic's self check-in code, for clinics that have turned self
// check-in on. Patients scan it from their booking to check themselves in.
//
// Two forms (migration 84):
//   - Printed: a permanent signed code, stuck on the counter. Because a photo
//     of it works anywhere, the server ALWAYS checks the patient's phone is
//     at the clinic for this one - so it needs the clinic's map location.
//     "Replace printed QR" voids every old printout if one is misused.
//   - Screen: the original rotating code (section 28) for a tablet/monitor
//     left on at reception. Changes every 3 minutes, so an old photo fails.
export default function ClinicPoster() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [clinic, setClinic] = useState<{
    id: string;
    name: string;
    clinic_code: string | null;
    self_checkin_enabled: boolean;
    lat: number | null;
    lng: number | null;
  } | null>(null);
  const [mode, setMode] = useState<PosterMode>('print');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replaced, setReplaced] = useState(false);

  useEffect(() => {
    if (!profile) return;
    (async () => {
      // my_clinic_id() (schema.sql migration 57) resolves this account's
      // clinic whether it's the owner or a registered staff phone.
      const { data: id } = await supabase.rpc('my_clinic_id');
      const { data } = id
        ? await supabase
            .from('clinics')
            .select('id, name, clinic_code, self_checkin_enabled, lat, lng')
            .eq('id', id)
            .maybeSingle()
        : { data: null };
      setClinic(data as typeof clinic);
      setLoading(false);
    })();
  }, [profile]);

  // A plain string dependency, so the interval below isn't torn down and
  // rebuilt every time the clinic object is re-created.
  const clinicId = clinic?.id ?? null;
  const enabled = !!clinic?.self_checkin_enabled;

  const refresh = useCallback(async () => {
    if (!clinicId) return;
    const result = mode === 'print' ? await issueClinicStaticCode(clinicId) : await issueClinicCheckinCode(clinicId);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setCode(result.code);
  }, [clinicId, mode]);

  useEffect(() => {
    if (!clinicId || !enabled) return;
    refresh();
    if (mode !== 'screen') return;
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [clinicId, enabled, mode, refresh]);

  const replaceCode = async () => {
    if (!clinicId) return;
    setReplacing(true);
    const result = await rotateClinicStaticCode(clinicId);
    setReplacing(false);
    setConfirmReplace(false);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setCode(result.code);
    setReplaced(true);
  };

  const goFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };

  if (loading) return <p className="p-6 text-slate-400"><Loading /></p>;

  const hasLocation = clinic?.lat != null && clinic?.lng != null;

  return (
    <div className="min-h-screen bg-white">
      <div className="flex items-center justify-between px-4 py-4 sm:px-6 print:hidden">
        <button
          onClick={() => navigate('/')}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-400 hover:text-slate-700"
        >
          <ArrowLeft size={16} /> Back to console
        </button>
        {mode === 'screen' && (
          <button
            onClick={goFullscreen}
            aria-label="Toggle fullscreen"
            title="Fullscreen"
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <Maximize2 size={18} />
          </button>
        )}
      </div>

      <div className="mx-auto flex max-w-2xl flex-col items-center px-4 pb-12 text-center sm:px-6 print:pb-0">
        {!clinic ? (
          <p className="mt-20 text-slate-400">No clinic found for this account.</p>
        ) : !clinic.self_checkin_enabled ? (
          <div className="mt-20 max-w-md rounded-3xl bg-amber-50 p-6 text-amber-800">
            <p className="text-lg font-bold">Self check-in is switched off</p>
            <p className="mt-2 text-sm leading-relaxed">
              Patients can't check themselves in at this clinic yet, so this code won't work. Turn on{' '}
              <strong>Patient self check-in</strong> in the console's <strong>Booking mode</strong> tab.
            </p>
            <Button className="mt-4" onClick={() => navigate('/')}>
              Open console
            </Button>
          </div>
        ) : (
          <>
            <div className="w-full max-w-sm print:hidden">
              <Segmented
                options={[
                  { value: 'print', label: 'Printed QR' },
                  { value: 'screen', label: 'Reception screen' },
                ]}
                value={mode}
                onChange={(m) => {
                  if (m === mode) return;
                  setCode(null);
                  setMode(m);
                  setConfirmReplace(false);
                  setReplaced(false);
                }}
              />
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                {mode === 'print'
                  ? 'A permanent code to print and stick at the counter. Patients must be at the clinic (checked by their phone’s location) for it to work.'
                  : 'For a tablet or monitor left on at reception. The code changes every 3 minutes.'}
              </p>
            </div>

            {mode === 'print' && !hasLocation && (
              <div className="mt-4 flex w-full max-w-md items-start gap-2 rounded-2xl bg-red-50 p-3 text-left text-sm text-red-700 print:hidden">
                <MapPinOff size={17} className="mt-0.5 shrink-0" />
                <span>
                  Your clinic's map location isn't set, so patients can't check in with the printed QR yet. Set it in
                  the console's <strong>Location</strong> tab first.
                </span>
              </div>
            )}

            <h1 className="mt-8 text-4xl font-extrabold tracking-tight text-slate-900 print:mt-16 print:text-5xl">
              Scan to check in
            </h1>
            <p className="mt-2 text-lg text-slate-500 print:text-2xl">{clinic.name}</p>

            <div className="mt-8">
              {code ? (
                <QrCode value={code} size={340} className="ring-4 ring-brand-100" alt="Clinic check-in code" />
              ) : (
                <div className="flex h-[340px] w-[340px] max-w-full items-center justify-center rounded-2xl bg-slate-50 text-slate-400">
                  {error ?? 'Preparing code...'}
                </div>
              )}
            </div>

            <ol className="mt-8 space-y-2 text-left text-lg text-slate-600 print:text-xl">
              <li>
                <span className="font-bold text-brand-600">1.</span> Open SanjeevniOS and go to today's booking.
              </li>
              <li>
                <span className="font-bold text-brand-600">2.</span> Tap <strong>Scan clinic QR to check in</strong>.
              </li>
              <li>
                <span className="font-bold text-brand-600">3.</span> Point your camera here
                {mode === 'print' ? ' and allow location' : ''} — your token appears straight away.
              </li>
            </ol>

            <p className="mt-8 flex items-center gap-2 text-sm text-slate-400">
              <ShieldCheck size={15} />
              {mode === 'print'
                ? 'Works only at the clinic. Can’t scan? Show your booking code at the desk.'
                : 'This code changes every few minutes — a photo of it won’t work later.'}
            </p>

            {clinic.clinic_code && (
              <p className="mt-4 text-xs text-slate-300 print:hidden">
                Clinic ID: <span className="font-mono font-semibold text-slate-400">{clinic.clinic_code}</span>
              </p>
            )}

            {error && code && <p className="mt-3 text-sm text-red-600 print:hidden">{error}</p>}

            {mode === 'print' && code && (
              <div className="mt-6 flex w-full max-w-md flex-col items-center gap-3 print:hidden">
                <Button onClick={() => window.print()}>
                  <Printer size={16} /> Print QR
                </Button>
                {replaced && (
                  <p className="text-sm font-semibold text-emerald-600">
                    New code ready. Print it and remove the old copies — they no longer work.
                  </p>
                )}
                {!confirmReplace ? (
                  <button
                    type="button"
                    onClick={() => setConfirmReplace(true)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 underline"
                  >
                    <RefreshCw size={12} /> Replace printed QR
                  </button>
                ) : (
                  <div className="w-full rounded-2xl border border-red-200 bg-red-50 p-3 text-left">
                    <p className="text-sm font-semibold text-red-700">Replace the printed QR?</p>
                    <p className="mt-0.5 text-xs text-red-700/80">
                      Every printed copy of the current code stops working immediately. Use this if a copy was taken
                      away or misused.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button variant="danger" onClick={replaceCode} disabled={replacing}>
                        {replacing ? 'Replacing...' : 'Replace printed QR'}
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmReplace(false)} disabled={replacing}>
                        Keep current QR
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
