import { Bell } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';

import HeroBand from './HeroBand';

interface Props {
  title: string;
  subtitle?: string;
  pill?: ReactNode;
  onBellClick?: () => void;
  bellDot?: boolean;
  /** Kept for the callers that pass it; every banner is left-aligned now. */
  centered?: boolean;
  action?: ReactNode;
}

// "Hello, Nikhil 👋": the hand waves, every few seconds.
function Title({ text }: { text: string }) {
  const i = text.indexOf('👋');
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <motion.span
        className="inline-block origin-[70%_75%]"
        animate={{ rotate: [0, 16, -8, 16, -4, 10, 0] }}
        transition={{ duration: 1.7, repeat: Infinity, repeatDelay: 3, ease: 'easeInOut' }}
      >
        👋
      </motion.span>
      {text.slice(i + 2)}
    </>
  );
}

// The banner at the top of each tab-root screen: the title (in the display face)
// and a subtitle, with the notification bell as a glass button.
export default function AppHeader({ title, subtitle, pill, onBellClick, bellDot, action }: Props) {
  return (
    <HeroBand>
      <div className="flex items-center justify-between gap-3">
        <motion.div
          className="min-w-0 flex-1"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="truncate font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl lg:text-4xl">
            <Title text={title} />
          </p>
          {subtitle && <p className="mt-1.5 truncate text-xs text-white/75 sm:text-sm">{subtitle}</p>}
        </motion.div>
        <div className="flex shrink-0 items-center gap-2">
          {pill}
          {action}
          {onBellClick && (
            <motion.button
              onClick={onBellClick}
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              className="relative cursor-pointer rounded-full bg-white/15 p-2.5 text-white ring-1 ring-white/25 backdrop-blur outline-none transition-colors hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white"
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
                <span className="absolute right-1.5 top-1.5 flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-300 ring-2 ring-white/40" />
                </span>
              )}
            </motion.button>
          )}
        </div>
      </div>
    </HeroBand>
  );
}
