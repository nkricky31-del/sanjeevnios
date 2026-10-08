import type { PropsWithChildren } from 'react';

// The surface everything is built on: a hairline border on the card ground,
// no shadow (the website only ever shadows its deck cards).
export default function Card({ children, className = '' }: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={`rounded-2xl border border-slate-100 bg-white p-4 ${className}`}>
      {children}
    </div>
  );
}
