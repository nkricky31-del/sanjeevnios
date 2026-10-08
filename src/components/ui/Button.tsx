import type { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'coral' | 'danger' | 'ghost' | 'dark';
  full?: boolean;
}

// Sizes/radii match the mockups: tall, generously rounded, bold label.
// 'outline' is the white-with-violet-border pairing used next to a primary
// action ("Reschedule" beside "View Details"); 'danger' is the red outline
// destructive action ("Cancel Appointment").
// A diagonal band of light that sweeps across a filled button on hover.
const SHINE =
  'relative overflow-hidden after:pointer-events-none after:absolute after:inset-y-0 after:-left-1/2 after:w-1/3 after:-skew-x-[20deg] after:bg-white/25 after:opacity-0 hover:after:left-[130%] hover:after:opacity-100 after:transition-all after:duration-700 disabled:after:hidden';

const VARIANTS: Record<string, string> = {
  // The role's accent: indigo for patients, emerald for clinics, deep slate for admin.
  primary: `bg-brand-600 text-white hover:bg-brand-700 ${SHINE}`,
  secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  outline: 'border border-slate-200 bg-transparent text-slate-700 hover:border-brand-500 hover:text-brand-600',
  // The clinic's old coral action, now the site's amber.
  coral: `bg-coral-500 text-white hover:bg-coral-600 ${SHINE}`,
  danger: 'border border-red-200 bg-red-50 text-red-600 hover:bg-red-100',
  ghost: 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
  dark: 'bg-slate-900 text-white hover:bg-slate-800',
};

export default function Button({ variant = 'primary', full, className = '', ...props }: Props) {
  return (
    <button
      {...props}
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${VARIANTS[variant]} ${full ? 'w-full' : ''} ${className}`}
    />
  );
}
