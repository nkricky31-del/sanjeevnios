import type { PropsWithChildren } from 'react';

export default function Card({ children, className = '' }: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={`rounded-3xl border border-slate-100 bg-white p-4 shadow-sm shadow-slate-200/50 ${className}`}>
      {children}
    </div>
  );
}
