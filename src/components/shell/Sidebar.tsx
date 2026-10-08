import { LogOut, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';

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
  'group relative flex hover:bg-white/[0.06] w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/60';
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

// Every item has its own colour, so a long list reads at a glance and each one
// lights up when you point at it.
const HUES = ['#818cf8', '#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb7185', '#2dd4bf'];

function Inner({ it, active, hue }: { it: NavItem; active: boolean; hue: string }) {
  return (
    <>
      {active && <ActiveMark />}
      <span
        className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all duration-300 group-hover:-rotate-6 group-hover:scale-110 group-hover:bg-[var(--h)] group-hover:text-slate-900 group-hover:shadow-[0_0_18px_-2px_var(--h)] ${
          active ? 'bg-[var(--h)] text-slate-900 shadow-[0_0_18px_-2px_var(--h)]' : 'bg-[color-mix(in_srgb,var(--h)_20%,transparent)] text-[var(--h)]'
        }`}
        style={{ ['--h' as string]: hue }}
      >
        <it.icon size={17} strokeWidth={1.9} />
      </span>
      <span className="relative transition-transform duration-300 group-hover:translate-x-1">{it.label}</span>
    </>
  );
}

// The laptop-and-up navigation. A deep gradient in the role's colour, a glow
// that drifts slowly behind it, items that slide in, and a highlight that glides
// between them. Phones use the bottom bar (patient) or scrolling pills.
export default function Sidebar({ tag, items, onHome, mobile = false }: { tag: string; items: NavItem[]; /** Called when the logo is clicked, to go back to the first screen. */ onHome?: () => void; /** Render as the slide-in menu panel on a phone instead of the fixed laptop sidebar. */ mobile?: boolean }) {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const who = profile?.name || (profile?.phone ? `+${profile.phone}` : 'Signed in');

  return (
    <aside
      className={mobile ? 'relative flex h-full w-72 max-w-[85vw] flex-col overflow-hidden shadow-2xl shadow-black/50' : 'fixed inset-y-0 left-0 z-30 hidden w-64 flex-col overflow-hidden lg:flex'}
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
        <Link to="/" onClick={onHome ? (e) => { e.preventDefault(); onHome(); navigate('/'); window.scrollTo({ top: 0, behavior: 'smooth' }); } : undefined} className="flex items-center gap-2.5 font-display text-lg font-bold tracking-[-0.02em] text-white outline-none focus-visible:underline">
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
        {items.map((it, idx) => (
          <motion.div key={it.key} variants={row}>
            {it.to ? (
              <NavLink to={it.to} end={it.end} className={({ isActive }) => `${ITEM} ${isActive ? ON : OFF}`}>
                {({ isActive }) => <Inner it={it} active={isActive} hue={HUES[idx % HUES.length]} />}
              </NavLink>
            ) : (
              <button type="button" onClick={it.onSelect} aria-current={it.active ? 'page' : undefined} className={`${ITEM} ${it.active ? ON : OFF}`}>
                <Inner it={it} active={Boolean(it.active)} hue={HUES[idx % HUES.length]} />
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

// The same menu as the laptop sidebar, as a panel that slides in from the left on
// a phone. Tapping an item, the logo or the dim background closes it; swiping it
// left, or pressing Escape, does too.
export function MobileDrawer({
  open, onClose, tag, items, onHome,
}: { open: boolean; onClose: () => void; tag: string; items: NavItem[]; onHome?: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);

  const closing = items.map((it) => ({ ...it, onSelect: it.onSelect ? () => { it.onSelect?.(); onClose(); } : undefined }));
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <motion.div
            className="absolute inset-0 bg-slate-950/55 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.div
            className="absolute inset-y-0 left-0"
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0.4, right: 0 }}
            onDragEnd={(_, info) => { if (info.offset.x < -70 || info.velocity.x < -400) onClose(); }}
          >
            <Sidebar mobile tag={tag} items={closing} onHome={() => { onHome?.(); onClose(); }} />
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
