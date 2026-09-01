import type { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'coral' | 'danger' | 'ghost';
  full?: boolean;
}

// Sizes/radii match the mockups: tall, generously rounded, bold label.
// 'outline' is the white-with-violet-border pairing used next to a primary
// action ("Reschedule" beside "View Details"); 'danger' is the red outline
// destructive action ("Cancel Appointment").
const VARIANTS: Record<string, string> = {
  primary: 'bg-brand-600 text-white shadow-sm shadow-brand-600/25 hover:bg-brand-700',
  secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  outline: 'border border-brand-200 bg-white text-brand-600 hover:bg-brand-50',
  coral: 'bg-coral-500 text-white shadow-sm shadow-coral-500/20 hover:bg-coral-600',
  danger: 'border border-red-200 bg-red-50 text-red-600 hover:bg-red-100',
  ghost: 'text-slate-500 hover:bg-slate-100',
};

export default function Button({ variant = 'primary', full, className = '', ...props }: Props) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-bold transition disabled:opacity-50 ${VARIANTS[variant]} ${full ? 'w-full' : ''} ${className}`}
    />
  );
}
