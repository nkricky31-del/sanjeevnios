import type { PropsWithChildren } from 'react';

export default function Card({ children, className = '' }: PropsWithChildren<{ className?: string }>) {
  return <div className={`rounded-2xl border border-slate-100 bg-white p-4 shadow-sm ${className}`}>{children}</div>;
}
