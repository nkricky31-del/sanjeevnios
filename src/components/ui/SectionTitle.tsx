import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { Link } from 'react-router-dom';

interface Props {
  children: ReactNode;
  /** "View All"-style link on the right of the heading. */
  actionLabel?: string;
  actionTo?: string;
  onAction?: () => void;
  className?: string;
}

// Section heading + optional right-aligned action, e.g.
// "Recent Encounters            View All".
export default function SectionTitle({ children, actionLabel, actionTo, onAction, className = '' }: Props) {
  return (
    <div className={`flex items-center justify-between gap-3 ${className}`}>
      <h2 className="flex items-center gap-2 font-display text-base font-bold tracking-[-0.02em] text-slate-900">
        <motion.span
          aria-hidden
          className="h-4 w-1 origin-center rounded-full bg-brand-600"
          initial={{ scaleY: 0, opacity: 0 }}
          whileInView={{ scaleY: 1, opacity: 1 }}
          viewport={{ once: true }}
          transition={{ type: 'spring', stiffness: 300, damping: 18, delay: 0.1 }}
        />
        {children}
      </h2>
      {actionLabel &&
        (actionTo ? (
          <Link to={actionTo} className="cursor-pointer text-sm font-semibold text-brand-600 underline-offset-4 hover:underline">
            {actionLabel}
          </Link>
        ) : (
          <button onClick={onAction} className="cursor-pointer text-sm font-semibold text-brand-600 underline-offset-4 hover:underline">
            {actionLabel}
          </button>
        ))}
    </div>
  );
}
