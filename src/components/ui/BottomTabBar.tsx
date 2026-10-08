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

export default function BottomTabBar() {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-20 rounded-2xl border border-slate-200/80 bg-white/90 shadow-xl shadow-slate-900/15 backdrop-blur-xl lg:hidden"
    >
      <div className="mx-auto flex max-w-xl items-stretch justify-around px-1 py-1.5">
        {PATIENT_TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `relative flex flex-1 flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-[10px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 ${
                isActive ? 'text-brand-600' : 'text-slate-400'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId="tabbar-pill"
                    aria-hidden
                    className="absolute inset-0 rounded-xl bg-brand-50 ring-1 ring-brand-100"
                    transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  />
                )}
                <motion.span
                  className="relative"
                  animate={{ scale: isActive ? 1.2 : 1, y: isActive ? -2 : 0 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 18 }}
                >
                  <t.icon size={19} strokeWidth={isActive ? 2.1 : 1.75} />
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
