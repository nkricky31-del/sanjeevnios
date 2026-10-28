import { Clock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { LOGIN_PATH, markActive, msUntilIdle, signOutForInactivity, type IdleRole } from '../lib/idleTimeout';

// Screens meant to stay on unattended (token board on a TV, the reception
// check-in code on a tablet) - they never time out.
const KIOSK_PATHS = ['/board', '/poster'];
// Real use only. Not focus/visibility: coming back to the app after the limit
// must sign out, not count as activity.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
const WARN_MS = 60_000;

// Watches a signed-in session for inactivity (see lib/idleTimeout.ts): records
// activity, warns a minute before the limit while the app is on screen, and
// signs this device out when the limit passes - then sends the person to their
// own login screen, which says why.
export default function IdleGuard({ role }: { role: IdleRole }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const kioskRef = useRef(false);
  const hereRef = useRef('/');
  const warningRef = useRef(false);
  const signingOutRef = useRef(false);
  const stayRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    kioskRef.current = KIOSK_PATHS.includes(location.pathname);
    hereRef.current = location.pathname + location.search;
  }, [location.pathname, location.search]);

  useEffect(() => {
    let lastWrite = 0;

    const hideWarning = () => {
      if (!warningRef.current) return;
      warningRef.current = false;
      setSecondsLeft(null);
    };

    const onActivity = () => {
      const now = Date.now();
      if (warningRef.current) {
        hideWarning();
        lastWrite = now;
        markActive(now);
        return;
      }
      // Write at most every 10s - plenty of precision for a minutes-long limit.
      if (now - lastWrite > 10_000) {
        lastWrite = now;
        markActive(now);
      }
    };

    const check = () => {
      if (signingOutRef.current) return;
      if (kioskRef.current) {
        markActive();
        hideWarning();
        return;
      }
      const left = msUntilIdle(role);
      if (left <= 0) {
        signingOutRef.current = true;
        hideWarning();
        const here = hereRef.current;
        const next = here && here !== '/' ? `?next=${encodeURIComponent(here)}` : '';
        void signOutForInactivity(role).then(() => navigate(LOGIN_PATH[role] + next, { replace: true }));
        return;
      }
      if (left <= WARN_MS && document.visibilityState === 'visible') {
        warningRef.current = true;
        setSecondsLeft(Math.max(1, Math.ceil(left / 1000)));
      } else {
        // e.g. activity in another tab moved the clock on
        hideWarning();
      }
    };

    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true, capture: true }));
    const onReturn = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    const timer = window.setInterval(check, 1000);
    check();

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity, { capture: true }));
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.clearInterval(timer);
    };
  }, [role, navigate]);

  // Move focus to the button when the warning first appears, so a keyboard
  // user can stay signed in with one key press.
  const shown = secondsLeft != null;
  useEffect(() => {
    if (shown) stayRef.current?.focus();
  }, [shown]);

  if (secondsLeft == null) return null;
  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, '0');

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[110] flex justify-center px-4">
      <div
        role="alertdialog"
        aria-labelledby="idle-title"
        aria-describedby="idle-desc"
        className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-2xl border border-amber-200 bg-white p-4 shadow-2xl"
      >
        <Clock size={20} className="mt-0.5 shrink-0 text-amber-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <p id="idle-title" className="text-sm font-bold text-slate-900">
            Still there?
          </p>
          <p id="idle-desc" className="mt-0.5 text-sm text-slate-600">
            For your security you'll be signed out in about a minute.{' '}
            <span aria-hidden className="font-mono font-semibold text-slate-900">
              {mm}:{ss}
            </span>
          </p>
        </div>
        <button
          ref={stayRef}
          type="button"
          onClick={() => {
            markActive();
            warningRef.current = false;
            setSecondsLeft(null);
          }}
          className="shrink-0 rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white outline-none hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          Stay signed in
        </button>
      </div>
    </div>
  );
}
