import { Share, WifiOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useInstall } from '../lib/pwa';
import BrandName from './ui/BrandName';

const DISMISS_KEY = 'sos-install-dismissed';
const QUIET_DAYS = 14;

function recentlyDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return at > 0 && Date.now() - at < QUIET_DAYS * 86400000;
  } catch {
    return false;
  }
}

// A small card, phone-sized screens only, offering to add the app to the home
// screen. Shown a few seconds after load, never inside the installed app, and
// not again for two weeks after "Not now".
export function InstallBanner() {
  const { canPrompt, installed, iosSafari, install } = useInstall();
  const [ready, setReady] = useState(false);
  const [hidden, setHidden] = useState(recentlyDismissed());

  useEffect(() => {
    const t = setTimeout(() => setReady(true), 8000);
    return () => clearTimeout(t);
  }, []);

  if (installed || hidden || !ready || !(canPrompt || iosSafari)) return null;

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* private mode: it simply comes back next visit */
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Install SanjeevniOS"
      className="fixed inset-x-3 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-40 rounded-2xl border border-slate-200 bg-white p-4 shadow-lg shadow-slate-900/10 lg:hidden"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Close"
        className="absolute right-2 top-2 cursor-pointer rounded-full p-1.5 text-slate-400 outline-none hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <X size={16} />
      </button>
      <div className="flex items-start gap-3 pr-6">
        <img src="/icon-192.png" alt="" width={44} height={44} className="h-11 w-11 shrink-0 rounded-xl" />
        <div className="min-w-0">
          <p className="font-display text-sm font-bold text-slate-900">Install <BrandName /></p>
          {canPrompt ? (
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
              Add it to your home screen to open it like an app.
            </p>
          ) : (
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
              Tap <Share size={12} className="inline -mt-0.5" /> <b>Share</b>, then <b>Add to Home Screen</b>.
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={dismiss}
          className="cursor-pointer rounded-xl px-3 py-2 text-xs font-semibold text-slate-500 outline-none hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Not now
        </button>
        {canPrompt && (
          <button
            type="button"
            onClick={async () => {
              await install();
              dismiss();
            }}
            className="cursor-pointer rounded-xl bg-brand-600 px-4 py-2 text-xs font-semibold text-white outline-none hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            Install
          </button>
        )}
      </div>
    </div>
  );
}

// A thin strip across the top while the device has no connection.
export function OfflineBanner() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 bg-slate-900 px-3 py-1.5 text-xs font-medium text-white"
    >
      <WifiOff size={13} /> You're offline. Booking and live updates need a connection.
    </div>
  );
}
