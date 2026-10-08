import { Bell } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';

import HeroBand from '../ui/HeroBand';
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
        <HeroBand>
          <div className="flex items-center justify-between gap-3">
            <motion.div
              className="min-w-0"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            >
              <h1 className="truncate font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl lg:text-4xl">{title}</h1>
              {subtitle && <p className="mt-1.5 truncate text-xs text-white/75 sm:text-sm">{subtitle}</p>}
            </motion.div>
            <div className="flex shrink-0 items-center gap-2">
              {pill}
              {onBell && (
                <motion.button
                  type="button"
                  onClick={onBell}
                  aria-label="Notifications"
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.92 }}
                  className="relative cursor-pointer rounded-full bg-white/15 p-2.5 text-white ring-1 ring-white/25 backdrop-blur outline-none transition-colors hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white"
                >
                  <motion.span
                    className="flex origin-top"
                    animate={bellDot ? { rotate: [0, -16, 14, -10, 6, 0] } : undefined}
                    transition={{ duration: 1.1, delay: 0.8, repeat: Infinity, repeatDelay: 6 }}
                  >
                    <Bell size={20} />
                  </motion.span>
                  {bellDot && (
                    <span className="absolute right-1.5 top-1.5 flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300 opacity-75" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-300 ring-2 ring-white/40" />
                    </span>
                  )}
                </motion.button>
              )}
            </div>
          </div>
        </HeroBand>

        <div className="px-4">
          <div className="mt-5 lg:hidden">
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
