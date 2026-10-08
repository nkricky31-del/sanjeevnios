import { LogOut, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { Link, NavLink } from 'react-router-dom';

import BrandMark from '../ui/BrandMark';
import Wordmark from '../ui/Wordmark';
import { useAuth } from '../../lib/AuthContext';
import { supabase } from '../../lib/supabaseClient';

export interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  /** A route link (patient app)... */
  to?: string;
  end?: boolean;
  /** ...or an in-page tab (clinic and admin consoles). */
  onSelect?: () => void;
  active?: boolean;
}

const ITEM =
  'group relative flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/60';
const ON = 'text-white';
const OFF = 'text-white/60 hover:text-white';

const list = { show: { transition: { staggerChildren: 0.045, delayChildren: 0.15 } } };
const row = {
  hidden: { opacity: 0, x: -14 },
  show: { opacity: 1, x: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as const } },
};

// The highlight that glides from one item to the next (shared layout animation),
// plus a glowing bar on the edge.
function ActiveMark() {
  return (
    <>
      <motion.span
        layoutId="sidebar-pill"
        className="absolute inset-0 rounded-xl bg-white/12 ring-1 ring-white/20"
        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      />
      <motion.span
        layoutId="sidebar-bar"
        className="absolute -left-3 top-1.5 h-7 w-1 rounded-full"
        style={{ background: 'var(--sidebar-light)', boxShadow: '0 0 14px var(--sidebar-glow)' }}
        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      />
    </>
  );
}

function Inner({ it, active }: { it: NavItem; active: boolean }) {
  return (
    <>
      {active && <ActiveMark />}
      <it.icon
        size={17}
        strokeWidth={1.75}
        className="relative transition-transform duration-200 group-hover:scale-110"
        style={active ? { color: 'var(--sidebar-light)' } : undefined}
      />
      <span className="relative">{it.label}</span>
    </>
  );
}

// The laptop-and-up navigation. A deep gradient in the role's colour, a glow
// that drifts slowly behind it, items that slide in, and a highlight that glides
// between them. Phones use the bottom bar (patient) or scrolling pills.
export default function Sidebar({ tag, items }: { tag: string; items: NavItem[] }) {
  const { profile } = useAuth();
  const who = profile?.name || (profile?.phone ? `+${profile.phone}` : 'Signed in');

  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col overflow-hidden lg:flex"
      style={{ background: 'var(--sidebar-bg)' }}
    >
      {/* ambient light */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -bottom-24 -left-16 h-72 w-72 rounded-full blur-3xl"
        style={{ background: 'var(--sidebar-glow)' }}
        animate={{ x: [0, 40, 0], y: [0, -30, 0], scale: [1, 1.2, 1] }}
        transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-16 h-56 w-56 rounded-full opacity-60 blur-3xl"
        style={{ background: 'var(--sidebar-glow)' }}
        animate={{ x: [0, -30, 0], y: [0, 30, 0] }}
        transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative px-6 pb-2 pt-8">
        <Link to="/" className="flex items-center gap-2.5 font-display text-lg font-bold tracking-[-0.02em] text-white outline-none focus-visible:underline">
          <BrandMark size={32} tone="light" />
          <Wordmark dotClassName="text-[var(--sidebar-light)]" />
        </Link>
        <p className="mt-2 flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.18em] text-white/60">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" style={{ background: 'var(--sidebar-light)' }} />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: 'var(--sidebar-light)' }} />
          </span>
          {tag}
        </p>
      </div>

      <motion.nav
        aria-label="Sections"
        className="relative mt-6 flex-1 space-y-1 overflow-y-auto px-6 pb-4"
        variants={list}
        initial="hidden"
        animate="show"
      >
        {items.map((it) => (
          <motion.div key={it.key} variants={row}>
            {it.to ? (
              <NavLink to={it.to} end={it.end} className={({ isActive }) => `${ITEM} ${isActive ? ON : OFF}`}>
                {({ isActive }) => <Inner it={it} active={isActive} />}
              </NavLink>
            ) : (
              <button type="button" onClick={it.onSelect} aria-current={it.active ? 'page' : undefined} className={`${ITEM} ${it.active ? ON : OFF}`}>
                <Inner it={it} active={Boolean(it.active)} />
              </button>
            )}
          </motion.div>
        ))}
      </motion.nav>

      <div className="relative flex items-center gap-3 border-t border-white/10 px-6 py-4">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 font-display text-sm font-bold text-white ring-1 ring-white/25"
        >
          {(profile?.name || tag).charAt(0).toUpperCase()}
        </span>
        <p className="min-w-0 flex-1 truncate text-sm text-white/85">{who}</p>
        <motion.button
          type="button"
          onClick={() => supabase.auth.signOut()}
          aria-label="Sign out"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.92 }}
          className="cursor-pointer rounded-full p-2 text-white/60 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <LogOut size={16} />
        </motion.button>
      </div>
    </aside>
  );
}
