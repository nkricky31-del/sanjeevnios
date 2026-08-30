import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface Props {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  tone?: 'brand' | 'coral' | 'emerald' | 'amber' | 'slate';
}

const TONE_BG: Record<string, string> = {
  brand: 'bg-brand-50 text-brand-600',
  coral: 'bg-coral-50 text-coral-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  slate: 'bg-slate-100 text-slate-600',
};

export default function StatTile({ icon: Icon, label, value, tone = 'brand' }: Props) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-3">
      <div className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${TONE_BG[tone]}`}>
        <Icon size={16} />
      </div>
      <p className="mt-2 text-xs text-slate-500">{label}</p>
      <p className="text-base font-bold text-slate-900">{value}</p>
    </div>
  );
}
