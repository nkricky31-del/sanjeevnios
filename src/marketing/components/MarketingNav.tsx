import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';

import BrandMark from '../../components/ui/BrandMark';
import Button from '../../components/ui/Button';

const LINKS = [
  { to: '/about', label: 'About' },
  { to: '/for-clinics', label: 'For Clinics' },
  { to: '/for-patients', label: 'For Patients' },
  { to: '/contact', label: 'Contact' },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm font-semibold transition ${isActive ? 'text-brand-600' : 'text-slate-600 hover:text-brand-600'}`;

// The public site's header - reachable ONLY while logged out (App.tsx only
// mounts MarketingSite for a signed-out visitor on one of its own paths), so
// "Get the app / Login" routes into PatientLogin.tsx and "Join us" routes
// into ClinicLogin.tsx (?mode=register skips straight past its Clinic ID
// field into the phone -> OTP -> clinic + at-least-one-doctor flow).
export default function MarketingNav() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-20 border-b border-slate-100 bg-white/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
        <Link to="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
          <BrandMark size={34} />
          <span className="text-lg font-extrabold tracking-tight text-brand-700">SanjeevniOS</span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={linkClass}>
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <Button variant="outline" onClick={() => navigate('/login')}>
            Get the app / Login
          </Button>
          <Button variant="primary" onClick={() => navigate('/clinic/login?mode=register')}>
            Join us
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="rounded-xl p-2 text-slate-600 md:hidden"
          aria-label={open ? 'Close menu' : 'Open menu'}
        >
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>

      {open && (
        <div className="border-t border-slate-100 px-5 pb-4 pt-2 md:hidden">
          <div className="flex flex-col gap-3">
            {LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} className={linkClass} onClick={() => setOpen(false)}>
                {l.label}
              </NavLink>
            ))}
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <Button variant="outline" full onClick={() => navigate('/login')}>
              Get the app / Login
            </Button>
            <Button variant="primary" full onClick={() => navigate('/clinic/login?mode=register')}>
              Join us
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
