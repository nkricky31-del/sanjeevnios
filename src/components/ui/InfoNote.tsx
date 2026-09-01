import { Info } from 'lucide-react';
import type { ReactNode } from 'react';

interface Props {
  title?: string;
  /** Rendered as a bulleted list when given, matching "Important Information". */
  bullets?: ReactNode[];
  children?: ReactNode;
  tone?: 'brand' | 'amber';
}

const TONES = {
  brand: { box: 'bg-brand-50', title: 'text-brand-700', body: 'text-slate-600', icon: 'text-brand-600' },
  amber: { box: 'bg-amber-50', title: 'text-amber-800', body: 'text-amber-800', icon: 'text-amber-600' },
};

// The soft violet "Important Information" panel from the detail screens -
// an ⓘ, a heading, and either a bulleted list or free content.
export default function InfoNote({ title, bullets, children, tone = 'brand' }: Props) {
  const t = TONES[tone];
  return (
    <div className={`rounded-2xl p-3.5 ${t.box}`}>
      <div className="flex items-start gap-2">
        <Info size={16} className={`mt-0.5 shrink-0 ${t.icon}`} />
        <div className="min-w-0 flex-1">
          {title && <p className={`text-sm font-bold ${t.title}`}>{title}</p>}
          {bullets && (
            <ul className={`mt-1 space-y-1 text-xs leading-relaxed ${t.body}`}>
              {bullets.map((b, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-slate-400">•</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
          {children && <div className={`text-xs leading-relaxed ${t.body} ${title ? 'mt-1' : ''}`}>{children}</div>}
        </div>
      </div>
    </div>
  );
}
