import { AnimatePresence, motion } from 'motion/react';
import { useState, type ButtonHTMLAttributes, type PointerEvent } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'coral' | 'danger' | 'ghost' | 'dark';
  full?: boolean;
}

// A diagonal band of light that sweeps across a filled button on hover.
const SHINE =
  'after:pointer-events-none after:absolute after:inset-y-0 after:-left-1/2 after:w-1/3 after:-skew-x-[20deg] after:bg-white/25 after:opacity-0 hover:after:left-[130%] hover:after:opacity-100 after:transition-all after:duration-700 disabled:after:hidden';

const VARIANTS: Record<string, string> = {
  // The role's accent: indigo for patients, emerald for clinics, deep slate for admin.
  primary: `bg-brand-600 text-white hover:bg-brand-700 hover:shadow-lg hover:shadow-brand-600/25 ${SHINE}`,
  secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  outline: 'border border-slate-200 bg-transparent text-slate-700 hover:border-brand-500 hover:text-brand-600',
  coral: `bg-coral-500 text-white hover:bg-coral-600 hover:shadow-lg hover:shadow-coral-500/25 ${SHINE}`,
  danger: 'border border-red-200 bg-red-50 text-red-600 hover:bg-red-100',
  ghost: 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
  dark: 'bg-slate-900 text-white hover:bg-slate-800',
};

// Press it and a soft circle grows out from exactly where you touched, in the
// button's own text colour; it also lifts slightly on hover and settles on press.
export default function Button({ variant = 'primary', full, className = '', onPointerDown, children, ...props }: Props) {
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);

  const handleDown = (e: PointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(e);
    if (props.disabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setRipples((rs) => [...rs.slice(-3), { id: Date.now() + Math.random(), x: e.clientX - rect.left, y: e.clientY - rect.top }]);
  };

  return (
    <button
      data-fx="own"
      {...props}
      onPointerDown={handleDown}
      className={`relative inline-flex cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-xl px-4 py-2.5 text-sm font-semibold outline-none transition duration-200 hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas active:translate-y-0 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 ${VARIANTS[variant]} ${full ? 'w-full' : ''} ${className}`}
    >
      {children}
      <AnimatePresence>
        {ripples.map((r) => (
          <motion.span
            key={r.id}
            aria-hidden
            className="pointer-events-none absolute h-24 w-24 rounded-full bg-current"
            style={{ left: r.x - 48, top: r.y - 48 }}
            initial={{ scale: 0, opacity: 0.28 }}
            animate={{ scale: 4.5, opacity: 0 }}
            transition={{ duration: 0.65, ease: 'easeOut' }}
            onAnimationComplete={() => setRipples((rs) => rs.filter((x) => x.id !== r.id))}
          />
        ))}
      </AnimatePresence>
    </button>
  );
}
