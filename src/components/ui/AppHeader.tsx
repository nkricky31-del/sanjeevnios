import { Bell } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: string;
  pill?: ReactNode;
  onBellClick?: () => void;
  bellDot?: boolean;
  /** Centres the title and drops the greeting layout - used by tab roots
      that are titled rather than personalised ("My Health Records"). */
  centered?: boolean;
  action?: ReactNode;
}

// Tab-root header: a big left-aligned greeting ("Hello, Rahul 👋" with the
// MRN under it) plus the notification bell, or a centred title when the
// screen is titled rather than personalised.
export default function AppHeader({ title, subtitle, pill, onBellClick, bellDot, centered, action }: Props) {
  return (
    <div className="sticky top-0 z-10 border-b border-slate-100 bg-canvas/85 px-4 pb-4 pt-5 backdrop-blur-[14px] lg:border-b-0 lg:px-4 lg:pt-8">
      <div className="flex items-center justify-between gap-3">
        {centered && <div className="w-9" />}
        <motion.div
          className={centered ? 'flex-1 text-center' : 'min-w-0 flex-1'}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className={`truncate font-display font-bold tracking-[-0.02em] text-slate-900 ${centered ? 'text-lg' : 'text-xl lg:text-3xl'}`}>{title}</p>
          {subtitle && <p className="mt-1 truncate text-xs text-slate-500">{subtitle}</p>}
        </motion.div>
        <div className="flex shrink-0 items-center gap-2">
          {pill}
          {action}
          {onBellClick && (
            <motion.button
              onClick={onBellClick}
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              className="relative cursor-pointer rounded-full border border-slate-100 p-2 text-slate-600 outline-none transition hover:border-slate-300 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label="Notifications"
            >
              <motion.span
                className="flex origin-top"
                animate={bellDot ? { rotate: [0, -16, 14, -10, 6, 0] } : undefined}
                transition={{ duration: 1.1, delay: 0.8, repeat: Infinity, repeatDelay: 6 }}
              >
                <Bell size={20} />
              </motion.span>
              {bellDot && (
                <span className="absolute right-1.5 top-1.5 flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-coral-500 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-coral-500 ring-2 ring-canvas" />
                </span>
              )}
            </motion.button>
          )}
        </div>
      </div>
    </div>
  );
}
