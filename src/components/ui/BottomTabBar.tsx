import { CalendarDays, CreditCard, FileText, Home, User } from 'lucide-react';
import { NavLink } from 'react-router-dom';

// The five tabs from the mockups. Doctor search lives behind Home's
// "Book Appointment" quick action rather than taking a tab of its own.
const TABS = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/bookings', label: 'Appointments', icon: CalendarDays, end: false },
  { to: '/records', label: 'Records', icon: FileText, end: false },
  { to: '/payments', label: 'Payments', icon: CreditCard, end: false },
  { to: '/profile', label: 'Profile', icon: User, end: false },
];

export default function BottomTabBar() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-100 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="mx-auto flex max-w-md items-stretch justify-around px-1 py-1.5">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-1 rounded-2xl px-1 py-1.5 text-[11px] font-semibold transition ${
                isActive ? 'text-brand-600' : 'text-slate-400'
              }`
            }
          >
            <t.icon size={20} />
            <span className="truncate">{t.label}</span>
          </NavLink>
        ))}
      </div>
    </div>
  );
}
