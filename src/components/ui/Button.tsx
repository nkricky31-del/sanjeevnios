import type { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'coral' | 'danger' | 'ghost' | 'dark';
  full?: boolean;
}

// Sizes/radii match the mockups: tall, generously rounded, bold label.
// 'outline' is the white-with-violet-border pairing used next to a primary
// action ("Reschedule" beside "View Details"); 'danger' is the red outline
// destructive action ("Cancel Appointment").
const VARIANTS: Record<string, string> = {
  // Bone-coloured, like the website's buttons (the accent shows as a focus ring).
  primary: 'bg-slate-900 text-white hover:bg-slate-800',
  secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  outline: 'border border-slate-200 bg-transparent text-slate-700 hover:border-brand-500 hover:text-brand-600',
  // The clinic's old coral action, now the site's amber.
  coral: 'bg-coral-500 text-white hover:bg-coral-600',
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
