import { Bell } from 'lucide-react';
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
    <div className="sticky top-0 z-10 bg-canvas/95 px-4 pb-3 pt-4 backdrop-blur">
      <div className="mx-auto flex max-w-md items-center justify-between gap-3">
        {centered && <div className="w-9" />}
        <div className={centered ? 'flex-1 text-center' : 'min-w-0 flex-1'}>
          <p className={`truncate font-bold text-slate-900 ${centered ? 'text-base' : 'text-xl'}`}>{title}</p>
          {subtitle && <p className="mt-0.5 truncate text-xs text-slate-500">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pill}
          {action}
          {onBellClick && (
            <button
              onClick={onBellClick}
              className="relative rounded-full p-2 text-slate-600 hover:bg-slate-100"
              aria-label="Notifications"
            >
              <Bell size={20} />
              {bellDot && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-coral-500 ring-2 ring-canvas" />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
