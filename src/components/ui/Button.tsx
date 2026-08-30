import type { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'coral' | 'danger' | 'ghost';
  full?: boolean;
}

const VARIANTS: Record<string, string> = {
  primary: 'bg-brand-600 text-white shadow-sm shadow-brand-600/20 hover:bg-brand-700',
  secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  coral: 'bg-coral-500 text-white shadow-sm shadow-coral-500/20 hover:bg-coral-600',
  danger: 'bg-red-50 text-red-600 hover:bg-red-100',
  ghost: 'text-slate-500 hover:bg-slate-100',
};

export default function Button({ variant = 'primary', full, className = '', ...props }: Props) {
  return (
    <button
      {...props}
      className={`rounded-2xl px-4 py-2.5 text-sm font-bold transition disabled:opacity-50 ${VARIANTS[variant]} ${full ? 'w-full' : ''} ${className}`}
    />
  );
}
