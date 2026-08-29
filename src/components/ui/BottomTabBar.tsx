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
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white">
      <div className="mx-auto flex max-w-md items-center justify-around py-2">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 px-3 py-1 text-xs font-medium ${
                isActive ? 'text-blue-600' : 'text-slate-400'
              }`
            }
          >
            <t.icon size={20} />
            {t.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
