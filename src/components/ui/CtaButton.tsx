import { ArrowRight } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';

// The one big action on a screen ("Book Appointment"). The role's gradient, a
// band of light that sweeps across it every few seconds, and an arrow that
// leans forward on hover.
export default function CtaButton({ children, onClick, className = '' }: { children: ReactNode; onClick: () => void; className?: string }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ scale: 1.012, y: -1 }}
      whileTap={{ scale: 0.985 }}
      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
      className={`group relative flex w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-xl px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-slate-900/10 outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${className}`}
      style={{ background: 'var(--band-bg)' }}
    >
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/4 -skew-x-[20deg] bg-white/30"
        animate={{ left: ['-30%', '130%'] }}
        transition={{ duration: 1.4, repeat: Infinity, repeatDelay: 3.2, ease: 'easeInOut' }}
      />
      <span className="relative">{children}</span>
      <ArrowRight size={16} className="relative transition-transform duration-300 group-hover:translate-x-1" />
    </motion.button>
  );
}
