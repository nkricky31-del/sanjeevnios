import { Bell } from 'lucide-react';
import type { ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: string;
  pill?: ReactNode;
  onBellClick?: () => void;
  bellDot?: boolean;
}

export default function AppHeader({ title, subtitle, pill, onBellClick, bellDot }: Props) {
  return (
    <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-4">
      <div className="mx-auto flex max-w-md items-center justify-between">
        <div>
          <p className="text-lg font-bold text-slate-900">{title}</p>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {pill}
          <button
            onClick={onBellClick}
            className="relative rounded-full p-1.5 text-slate-500 hover:bg-slate-100"
            aria-label="Notifications"
          >
            <Bell size={18} />
            {bellDot && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-blue-500" />}
          </button>
        </div>
      </div>
    </div>
  );
}
