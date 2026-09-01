import type { ReactNode } from 'react';
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
      <h2 className="text-base font-bold text-slate-900">{children}</h2>
      {actionLabel &&
        (actionTo ? (
          <Link to={actionTo} className="text-sm font-bold text-brand-600">
            {actionLabel}
          </Link>
        ) : (
          <button onClick={onAction} className="text-sm font-bold text-brand-600">
            {actionLabel}
          </button>
        ))}
    </div>
  );
}
