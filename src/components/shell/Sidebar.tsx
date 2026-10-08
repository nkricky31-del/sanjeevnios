import { LogOut, type LucideIcon } from 'lucide-react';
import { Link, NavLink } from 'react-router-dom';

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
  'relative flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-brand-500';
const ON = 'bg-slate-100 text-slate-900';
const OFF = 'text-slate-500 hover:bg-slate-50 hover:text-slate-900';

function Bar() {
  return <span aria-hidden className="absolute -left-3 top-2 h-6 w-0.5 rounded-full bg-brand-600" />;
}

// The laptop-and-up navigation: wordmark, the destinations, who is signed in.
// Phones use the bottom bar (patient) or scrolling pills (clinic / admin).
export default function Sidebar({ tag, items }: { tag: string; items: NavItem[] }) {
  const { profile } = useAuth();
  const who = profile?.name || (profile?.phone ? `+${profile.phone}` : 'Signed in');

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-100 bg-canvas lg:flex">
      <div className="px-6 pb-2 pt-8">
        <Link to="/" className="font-display text-lg font-bold tracking-[-0.02em] text-slate-900 outline-none focus-visible:underline">
          SanjeevniOS<span className="text-brand-600">.</span>
        </Link>
        <p className="mt-2 flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.14em] text-slate-500">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-600" />
          {tag}
        </p>
      </div>

      <nav aria-label="Sections" className="mt-6 flex-1 space-y-1 overflow-y-auto px-6 pb-4">
        {items.map((it) =>
          it.to ? (
            <NavLink key={it.key} to={it.to} end={it.end} className={({ isActive }) => `${ITEM} ${isActive ? ON : OFF}`}>
              {({ isActive }) => (
                <>
                  {isActive && <Bar />}
                  <it.icon size={17} strokeWidth={1.75} />
                  {it.label}
                </>
              )}
            </NavLink>
          ) : (
            <button key={it.key} type="button" onClick={it.onSelect} aria-current={it.active ? 'page' : undefined} className={`${ITEM} ${it.active ? ON : OFF}`}>
              {it.active && <Bar />}
              <it.icon size={17} strokeWidth={1.75} />
              {it.label}
            </button>
          )
        )}
      </nav>

      <div className="flex items-center gap-3 border-t border-slate-100 px-6 py-4">
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 font-display text-sm font-bold text-slate-900">
          {(profile?.name || tag).charAt(0).toUpperCase()}
        </span>
        <p className="min-w-0 flex-1 truncate text-sm text-slate-700">{who}</p>
        <button
          type="button"
          onClick={() => supabase.auth.signOut()}
          aria-label="Sign out"
          className="cursor-pointer rounded-full p-2 text-slate-500 outline-none transition hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
}
