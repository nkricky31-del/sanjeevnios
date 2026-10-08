import { Bell } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
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
          <motion.div
            className="min-w-0"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >
            <h1 className="truncate font-display text-xl font-bold tracking-[-0.02em] text-slate-900 lg:text-3xl">{title}</h1>
            {subtitle && <p className="mt-1 truncate text-xs text-slate-500">{subtitle}</p>}
          </motion.div>
          <div className="flex shrink-0 items-center gap-2">
            {pill}
            {onBell && (
              <motion.button
                type="button"
                onClick={onBell}
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.92 }}
                aria-label="Notifications"
                className="relative cursor-pointer rounded-full border border-slate-100 p-2 text-slate-600 outline-none transition hover:border-slate-300 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <motion.span
                  className="flex origin-top"
                  animate={bellDot ? { rotate: [0, -16, 14, -10, 6, 0] } : undefined}
                  transition={{ duration: 1.1, delay: 0.8, repeat: Infinity, repeatDelay: 6 }}
                >
                  <Bell size={20} />
                </motion.span>
                {bellDot && (
                  <span className="absolute right-1.5 top-1.5 flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-coral-500 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-coral-500 ring-2 ring-canvas" />
                  </span>
                )}
              </motion.button>
            )}
          </div>
        </header>

        <div className="px-4">
          <div className="lg:hidden">
            <Segmented options={tabs.map((t) => ({ value: t.value, label: t.label }))} value={value} onChange={onChange} variant="scroll" />
          </div>
          {active && <p className="mt-6 hidden text-[10.5px] font-medium uppercase tracking-[0.14em] text-slate-500 lg:block">{active.label}</p>}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={value}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } }}
              exit={{ opacity: 0, y: -8, transition: { duration: 0.14 } }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
