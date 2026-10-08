import type { LucideIcon } from 'lucide-react';

interface Props {
  label: string;
  tone?: 'live' | 'warning' | 'info' | 'neutral' | 'danger';
  icon?: LucideIcon;
  dot?: boolean;
}

// Soft status chips, as used throughout the mockups: green "Confirmed" /
// "Completed" / "Paid", amber "Upcoming", violet informational. Plain text
// by default; pass `icon` for the ✓-prefixed variant on detail screens, or
// `dot` for the live-queue look.
const TONE_STYLES: Record<string, string> = {
  live: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  info: 'bg-brand-50 text-brand-700',
  neutral: 'bg-slate-100 text-slate-600',
  danger: 'bg-red-50 text-red-600',
};

const DOT_STYLES: Record<string, string> = {
  live: 'bg-emerald-500',
  warning: 'bg-amber-500',
  info: 'bg-brand-500',
  neutral: 'bg-slate-400',
  danger: 'bg-red-500',
};

export default function StatusPill({ label, tone = 'neutral', icon: Icon, dot }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-current/15 px-3 py-1 text-[11px] font-semibold capitalize ${TONE_STYLES[tone]}`}
    >
      {dot && (
        <span className="relative flex h-1.5 w-1.5">
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-70 ${DOT_STYLES[tone]}`} />
          <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${DOT_STYLES[tone]}`} />
        </span>
      )}
      {Icon && <Icon size={13} />}
      {label}
    </span>
  );
}
