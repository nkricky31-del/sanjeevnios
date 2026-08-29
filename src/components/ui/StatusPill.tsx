interface Props {
  label: string;
  tone?: 'live' | 'warning' | 'info' | 'neutral';
}

const TONE_STYLES: Record<string, string> = {
  live: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  info: 'bg-blue-50 text-blue-700',
  neutral: 'bg-slate-100 text-slate-600',
};

const DOT_STYLES: Record<string, string> = {
  live: 'bg-emerald-500',
  warning: 'bg-amber-500',
  info: 'bg-blue-500',
  neutral: 'bg-slate-400',
};

export default function StatusPill({ label, tone = 'neutral' }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${TONE_STYLES[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_STYLES[tone]}`} />
      {label}
    </span>
  );
}
