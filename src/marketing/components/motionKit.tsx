import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

export const EASE = [0.22, 1, 0.36, 1] as const;

// Entry reveal: fires ONCE as the block scrolls into view and never un-reveals.
// With prefers-reduced-motion set it renders plain - the finished page.
export function Reveal({
  children, delay = 0, y = 26, className,
}: { children: ReactNode; delay?: number; y?: number; className?: string }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ duration: 0.75, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

// Small uppercase label used across the page (tracking .12em-.15em).
export function Label({ children, accent, className = '' }: { children: ReactNode; accent?: 'amber' | 'teal'; className?: string }) {
  const color = accent === 'amber' ? 'text-amber' : accent === 'teal' ? 'text-teal-text' : 'text-ink-2';
  return <p className={`font-ui text-[10.5px] font-medium uppercase tracking-[0.14em] ${color} ${className}`}>{children}</p>;
}
