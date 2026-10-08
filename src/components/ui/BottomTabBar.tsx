import { CalendarDays, CreditCard, FileText, Home, User } from 'lucide-react';
import { motion } from 'motion/react';
import { NavLink } from 'react-router-dom';

// The five patient tabs. On a phone this is the bottom bar; from `lg` up the
// sidebar (Sidebar.tsx) carries the same destinations, so this hides itself.
export const PATIENT_TABS = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/bookings', label: 'Appointments', icon: CalendarDays, end: false },
  { to: '/records', label: 'Records', icon: FileText, end: false },
  { to: '/payments', label: 'Payments', icon: CreditCard, end: false },
  { to: '/profile', label: 'Profile', icon: User, end: false },
];

// The same colours as the laptop sidebar, one per tab.
const HUES = ['#818cf8', '#38bdf8', '#34d399', '#fbbf24', '#f472b6'];

// A floating bar in the role's deep gradient (identical to the sidebar), with a
// coloured tile per tab that lights up and lifts when it is the current page.
export default function BottomTabBar() {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-20 overflow-hidden rounded-3xl shadow-2xl shadow-slate-900/40 ring-1 ring-white/15 lg:hidden"
      style={{ background: 'var(--sidebar-bg)' }}
    >
      <motion.span
        aria-hidden
        className="pointer-events-none absolute -bottom-10 left-0 h-24 w-40 rounded-full blur-2xl"
        style={{ background: 'var(--sidebar-glow)' }}
        animate={{ x: [0, 220, 0] }}
        transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="relative mx-auto flex max-w-xl items-stretch justify-around px-1 py-1.5">
        {PATIENT_TABS.map((t, i) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `relative flex flex-1 flex-col items-center gap-0.5 rounded-2xl px-1 py-1.5 text-[10px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/60 ${
                isActive ? 'text-white' : 'text-white/60'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId="tabbar-pill"
                    aria-hidden
                    className="absolute inset-0 rounded-2xl bg-white/12 ring-1 ring-white/20"
                    transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  />
                )}
                <motion.span
                  className="relative flex h-8 w-8 items-center justify-center rounded-xl"
                  style={{
                    background: isActive ? HUES[i] : `color-mix(in srgb, ${HUES[i]} 22%, transparent)`,
                    color: isActive ? '#0f172a' : HUES[i],
                    boxShadow: isActive ? `0 0 18px -2px ${HUES[i]}` : 'none',
                  }}
                  animate={{ scale: isActive ? 1.12 : 1, y: isActive ? -3 : 0 }}
                  whileTap={{ scale: 0.88 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 18 }}
                >
                  <t.icon size={18} strokeWidth={isActive ? 2.2 : 1.9} />
                </motion.span>
                <span className="relative truncate">{t.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
