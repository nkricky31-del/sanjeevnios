import { motion } from 'motion/react';

export interface ChartDatum {
  label: string;
  value: number;
  color?: string;
}

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#f43f5e', '#14b8a6'];
export const colorAt = (i: number) => PALETTE[i % PALETTE.length];

// Horizontal bars that grow in one after another, each with its count.
export function Bars({ data, className = '' }: { data: ChartDatum[]; className?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className={`space-y-2.5 ${className}`}>
      {data.map((d, i) => (
        <div key={d.label}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="truncate font-medium text-slate-700">{d.label}</span>
            <span className="font-bold tabular-nums text-slate-900">{d.value}</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
            <motion.div
              className="h-full rounded-full"
              style={{ background: d.color ?? colorAt(i), width: `${(d.value / max) * 100}%`, transformOrigin: 'left' }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.9, delay: 0.1 + i * 0.07, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// Vertical columns for a short time series.
export function Columns({ data, height = 96, color = '#6366f1' }: { data: ChartDatum[]; height?: number; color?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex items-end gap-1.5" style={{ height: height + 40, paddingTop: 16 }}>
      {data.map((d, i) => (
        <div key={d.label + i} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
          <span className="text-[10px] font-bold tabular-nums text-slate-500">{d.value || ''}</span>
          <motion.div
            className="w-full rounded-t-md"
            style={{ background: `linear-gradient(180deg, ${color}, ${color}66)`, height: Math.max(3, (d.value / max) * height), transformOrigin: 'bottom' }}
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={{ duration: 0.8, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
          />
          <span className="w-full truncate text-center text-[9px] text-slate-400">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

// A ring split into coloured arcs, with the total in the middle.
export function Donut({ data, size = 132, centre }: { data: ChartDatum[]; size?: number; centre?: string }) {
  const total = data.reduce((n, d) => n + d.value, 0);
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={14} />
          {total > 0 &&
            data.map((d, i) => {
              const len = (d.value / total) * c;
              const offset = -acc;
              acc += len;
              return (
                <motion.circle
                  key={d.label}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={d.color ?? colorAt(i)}
                  strokeWidth={14}
                  strokeLinecap="butt"
                  strokeDashoffset={offset}
                  initial={{ strokeDasharray: `0 ${c}` }}
                  animate={{ strokeDasharray: `${len} ${c - len}` }}
                  transition={{ duration: 0.9, delay: 0.15 + i * 0.12, ease: [0.22, 1, 0.36, 1] }}
                />
              );
            })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-2xl font-extrabold text-slate-900">{total}</span>
          {centre && <span className="text-[10px] uppercase tracking-wide text-slate-400">{centre}</span>}
        </div>
      </div>
      <ul className="space-y-1.5 text-xs">
        {data.map((d, i) => (
          <li key={d.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color ?? colorAt(i) }} />
            <span className="text-slate-600">{d.label}</span>
            <span className="font-bold tabular-nums text-slate-900">{d.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
