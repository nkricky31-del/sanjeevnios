import { motion } from 'motion/react';
import { useId } from 'react';

interface Props<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** 'pill' = the boxed toggle; 'underline' = the tab bar with an active
      underline; 'scroll' = a horizontally scrollable pill row, for the console
      screens that carry more tabs than fit across one line. */
  variant?: 'pill' | 'underline' | 'scroll';
}

const SPRING = { type: 'spring', stiffness: 420, damping: 34 } as const;

// Whichever tab is selected, its highlight GLIDES there from the previous one
// (a shared layout animation) instead of jumping.
export default function Segmented<T extends string>({ options, value, onChange, variant = 'pill' }: Props<T>) {
  const group = useId();

  if (variant === 'scroll') {
    return (
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={`relative shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-4 py-2 text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 ${
                active ? 'border-brand-600 text-brand-600' : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-900'
              }`}
            >
              {active && <motion.span layoutId={`${group}-pill`} transition={SPRING} className="absolute inset-0 rounded-full bg-brand-50" />}
              <span className="relative">{o.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  if (variant === 'underline') {
    return (
      <div className="flex border-b border-slate-100">
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={`relative flex-1 cursor-pointer pb-2.5 text-sm font-semibold outline-none transition-colors focus-visible:text-slate-900 ${
                active ? 'text-brand-600' : 'text-slate-400 hover:text-slate-700'
              }`}
            >
              {o.label}
              {active && (
                <motion.span layoutId={`${group}-line`} transition={SPRING} className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-brand-600" />
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex gap-1 rounded-2xl border border-slate-100 bg-white p-1">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`relative flex-1 cursor-pointer whitespace-nowrap rounded-xl px-3 py-2.5 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 ${
              active ? 'text-brand-600' : 'text-slate-500 hover:text-slate-900'
            }`}
          >
            {active && <motion.span layoutId={`${group}-box`} transition={SPRING} className="absolute inset-0 rounded-xl bg-brand-50" />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
