import { Calendar, Clock, Search, User } from 'lucide-react';
import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/', label: 'Search', icon: Search, end: true },
  { to: '/bookings', label: 'Bookings', icon: Calendar, end: false },
  { to: '/timeline', label: 'Timeline', icon: Clock, end: false },
  { to: '/profile', label: 'Profile', icon: User, end: false },
];

export default function BottomTabBar() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-100 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-md items-center justify-around py-2">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `flex flex-col items-center gap-1 rounded-2xl px-4 py-1.5 text-xs font-semibold transition ${
                isActive ? 'text-brand-600' : 'text-slate-400'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span className={`flex h-8 w-8 items-center justify-center rounded-xl ${isActive ? 'bg-brand-50' : ''}`}>
                  <t.icon size={19} />
                </span>
                {t.label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
