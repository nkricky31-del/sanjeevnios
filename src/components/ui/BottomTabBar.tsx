import { CalendarDays, CreditCard, FileText, Home, User } from 'lucide-react';
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
      className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-100 bg-canvas/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-[14px] lg:hidden"
    >
      <div className="mx-auto flex max-w-xl items-stretch justify-around px-1 py-1.5">
        {PATIENT_TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `relative flex flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-[10.5px] font-medium uppercase tracking-[0.06em] outline-none transition focus-visible:ring-2 focus-visible:ring-brand-500 ${
                isActive ? 'text-brand-600' : 'text-slate-400'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span aria-hidden className="absolute -top-1.5 h-0.5 w-8 rounded-full bg-brand-600" />}
                <t.icon size={19} strokeWidth={1.75} />
                <span className="truncate">{t.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
