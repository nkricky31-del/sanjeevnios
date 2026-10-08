import { ChevronRight, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';

import { CountUp } from '../../lib/motionKit';

interface Props {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  tone?: 'brand' | 'coral' | 'emerald' | 'amber' | 'slate';
  /** Makes the tile a button (it opens the matching section). */
  onClick?: () => void;
}

const TONE_BG: Record<string, string> = {
  brand: 'bg-brand-50 text-brand-600',
  coral: 'bg-coral-50 text-coral-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  slate: 'bg-slate-100 text-slate-600',
};

export default function StatTile({ icon: Icon, label, value, tone = 'brand', onClick }: Props) {
  const clickable = Boolean(onClick);
  return (
    <motion.div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } } : undefined}
      whileHover={{ y: -3 }}
      whileTap={clickable ? { scale: 0.97 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 24 }}
      className={`group relative rounded-2xl border border-slate-100 bg-white p-3 hover:border-brand-200 ${clickable ? 'cursor-pointer hover:shadow-lg hover:shadow-slate-900/5' : ''}`}
    >
      <div className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${TONE_BG[tone]}`}>
        <Icon size={16} />
      </div>
      {clickable && <ChevronRight size={16} className="absolute right-3 top-3 text-slate-300 transition group-hover:translate-x-1 group-hover:text-brand-500" />}
      <p className="mt-2 text-xs text-slate-500">{label}</p>
      <p className="text-base font-bold text-slate-900">{typeof value === 'number' ? <CountUp value={value} /> : value}</p>
    </motion.div>
  );
}
