import type { PropsWithChildren } from 'react';

// The white card every mockup screen is built out of: generous radius, a
// hairline border rather than a heavy shadow, sitting on the lavender canvas.
export default function Card({ children, className = '' }: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={`rounded-3xl border border-slate-100 bg-white p-4 shadow-sm shadow-slate-200/40 ${className}`}>
      {children}
    </div>
  );
}
