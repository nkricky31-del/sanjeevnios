import { Bell } from 'lucide-react';
import type { ReactNode } from 'react';

import Segmented from '../ui/Segmented';
import Sidebar, { type NavItem } from './Sidebar';

export interface ConsoleTab<T extends string> {
  value: T;
  label: string;
  icon: NavItem['icon'];
}

// The frame shared by the clinic and admin consoles. Laptop and up: a sidebar
// lists every tab and the page header sits above a wide content area. Phone:
// the same tabs become a row of scrolling pills under the header.
export default function ConsoleLayout<T extends string>({
  tag, title, subtitle, pill, tabs, value, onChange, bellDot, onBell, children,
}: {
  tag: string;
  title: string;
  subtitle?: string;
  pill?: ReactNode;
  tabs: ConsoleTab<T>[];
  value: T;
  onChange: (v: T) => void;
  bellDot?: boolean;
  onBell?: () => void;
  children: ReactNode;
}) {
  const active = tabs.find((t) => t.value === value);
  return (
    <div className="min-h-screen bg-canvas lg:pl-64">
      <Sidebar
        tag={tag}
        items={tabs.map((t) => ({ key: t.value, label: t.label, icon: t.icon, onSelect: () => onChange(t.value), active: t.value === value }))}
      />
      <main className="mx-auto w-full max-w-7xl pb-10 lg:px-6">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-100 bg-canvas/85 px-4 pb-4 pt-5 backdrop-blur-[14px] lg:border-b-0 lg:pt-8">
          <div className="min-w-0">
            <h1 className="truncate font-display text-xl font-bold tracking-[-0.02em] text-slate-900 lg:text-3xl">{title}</h1>
            {subtitle && <p className="mt-1 truncate text-xs text-slate-500">{subtitle}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {pill}
            {onBell && (
              <button
                type="button"
                onClick={onBell}
                aria-label="Notifications"
                className="relative cursor-pointer rounded-full border border-slate-100 p-2 text-slate-600 outline-none transition hover:border-slate-300 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <Bell size={20} />
                {bellDot && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-coral-500 ring-2 ring-canvas" />}
              </button>
            )}
          </div>
        </header>

        <div className="px-4">
          <div className="lg:hidden">
            <Segmented options={tabs.map((t) => ({ value: t.value, label: t.label }))} value={value} onChange={onChange} variant="scroll" />
          </div>
          {active && <p className="mt-6 hidden text-[10.5px] font-medium uppercase tracking-[0.14em] text-slate-500 lg:block">{active.label}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}
