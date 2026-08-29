import type { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  full?: boolean;
}

const VARIANTS: Record<string, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700',
  secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  danger: 'bg-red-50 text-red-600 hover:bg-red-100',
  ghost: 'text-slate-500 hover:bg-slate-100',
};

export default function Button({ variant = 'primary', full, className = '', ...props }: Props) {
  return (
    <button
      {...props}
      className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:opacity-50 ${VARIANTS[variant]} ${full ? 'w-full' : ''} ${className}`}
    />
  );
}
