import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { onInAppAlert, type InAppAlert } from '../lib/push';
import BrandMark from './ui/BrandMark';

const SHOW_MS = 8000;

// An alert that arrives while the app is open (lib/push.ts) shows here, at the
// top of the screen, instead of as a phone notification. Tapping it opens the
// booking. On that booking's own screen, or its pass, it isn't shown: the
// screen shows the news itself. The newest replaces the last; each goes after
// 8 seconds.
export default function PushBanner() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const where = useRef(pathname);
  const [alert, setAlert] = useState<InAppAlert | null>(null);

  useEffect(() => {
    where.current = pathname;
  }, [pathname]);

  useEffect(
    () =>
      onInAppAlert((next) => {
        if (next.route && (where.current === next.route || where.current === `${next.route}/pass`)) return;
        setAlert(next);
      }),
    [],
  );

  useEffect(() => {
    if (!alert) return;
    const timer = window.setTimeout(() => setAlert(null), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [alert]);

  const open = () => {
    if (alert?.route) navigate(alert.route);
    setAlert(null);
  };

  return (
    <div className="pointer-events-none fixed inset-x-3 top-[calc(env(safe-area-inset-top,0px)+0.5rem)] z-50 mx-auto max-w-md" aria-live="polite">
      <AnimatePresence>
        {alert && (
          <motion.div
            key={alert.key}
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.22 }}
            className="pointer-events-auto relative rounded-2xl border border-slate-200 bg-white shadow-lg shadow-slate-900/10"
          >
            <button
              type="button"
              onClick={open}
              className="flex w-full cursor-pointer items-start gap-3 rounded-2xl p-3.5 pr-10 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <BrandMark size={32} animated={false} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-slate-900">{alert.title}</span>
                <span className="mt-0.5 block text-sm leading-snug text-slate-600">{alert.body}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setAlert(null)}
              aria-label="Close"
              className="absolute right-2 top-2 cursor-pointer rounded-full p-1.5 text-slate-400 outline-none hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <X size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
