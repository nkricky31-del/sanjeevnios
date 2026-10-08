import type { LucideIcon } from 'lucide-react';

interface Props {
  label: string;
  tone?: 'live' | 'warning' | 'info' | 'neutral' | 'danger' | 'violet' | 'sky';
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
  violet: 'bg-violet-50 text-violet-700',
  sky: 'bg-sky-50 text-sky-700',
};

const DOT_STYLES: Record<string, string> = {
  live: 'bg-emerald-500',
  warning: 'bg-amber-500',
  info: 'bg-brand-500',
  neutral: 'bg-slate-400',
  danger: 'bg-red-500',
  violet: 'bg-violet-500',
  sky: 'bg-sky-500',
};

// A neutral grey pill whose word already says what it is takes that word's colour,
// so the same status looks the same on every screen.
const LABEL_TONE: Record<string, keyof typeof TONE_STYLES> = {
  pending: 'warning',
  hold: 'warning',
  'on hold': 'warning',
  collected: 'sky',
  refunded: 'violet',
  refund: 'violet',
  cancelled: 'danger',
  rejected: 'danger',
  failed: 'danger',
  captured: 'live',
  paid: 'live',
  settled: 'live',
  approved: 'live',
  active: 'live',
  released: 'info',
  eligible: 'info',
};

export default function StatusPill({ label, tone: given = 'neutral', icon: Icon, dot }: Props) {
  const tone = given === 'neutral' ? (LABEL_TONE[label.toLowerCase()] ?? 'neutral') : given;
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
