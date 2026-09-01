import type { LucideIcon } from 'lucide-react';

export type IconTone = 'brand' | 'emerald' | 'amber' | 'pink' | 'sky' | 'slate';

interface Props {
  icon: LucideIcon;
  tone?: IconTone;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

// The tinted rounded-square that sits in front of almost every row, card
// header and quick action in the mockups. Tones cycle so a list of
// categories reads as distinct at a glance (records categories, quick
// actions) without meaning anything in itself.
const TONES: Record<IconTone, string> = {
  brand: 'bg-brand-50 text-brand-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  pink: 'bg-pink-50 text-pink-600',
  sky: 'bg-sky-50 text-sky-600',
  slate: 'bg-slate-100 text-slate-600',
};

const SIZES = {
  sm: { box: 'h-9 w-9 rounded-xl', icon: 16 },
  md: { box: 'h-11 w-11 rounded-2xl', icon: 19 },
  lg: { box: 'h-14 w-14 rounded-2xl', icon: 24 },
};

export default function IconTile({ icon: Icon, tone = 'brand', size = 'md', className = '' }: Props) {
  const s = SIZES[size];
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${s.box} ${TONES[tone]} ${className}`}>
      <Icon size={s.icon} />
    </span>
  );
}
