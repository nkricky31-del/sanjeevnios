import { Menu, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';

import BrandMark from '../../components/ui/BrandMark';
import Wordmark from '../../components/ui/Wordmark';

const LINKS = [
  { to: '/about', label: 'About' },
  { to: '/for-clinics', label: 'For clinics' },
  { to: '/for-patients', label: 'For patients' },
  { to: '/contact', label: 'Contact' },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `font-ui text-[10.5px] font-medium uppercase tracking-[0.12em] transition-colors hover:text-primary focus-visible:text-primary ${
    isActive ? 'text-primary' : 'text-ink-2'
  }`;

// Fixed 58px bar on a translucent ground: 14px backdrop blur, bottom hairline,
// the wordmark with an amber full stop, uppercase links, one pill button.
// Reachable only while logged out (App.tsx mounts MarketingSite for a
// signed-out visitor). "Sign in" goes to the patient screen; clinics register
// from the page itself (?mode=register skips the Clinic ID field).
export default function MarketingNav() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-hairline bg-ground/70 backdrop-blur-[14px]">
      <div className="mx-auto flex h-[58px] max-w-6xl items-center justify-between px-5">
        <Link
          to="/"
          onClick={() => setOpen(false)}
          className="flex items-center gap-2 font-display text-[15px] font-bold tracking-[-0.02em] text-ink outline-none focus-visible:underline"
        >
          <BrandMark size={28} />
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-8 md:flex" aria-label="Main">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={linkClass}>
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="cursor-pointer rounded-full border border-ink/30 px-4 py-1.5 font-ui text-[10.5px] font-medium uppercase tracking-[0.12em] text-ink outline-none transition-colors hover:bg-primary hover:text-white focus-visible:ring-2 focus-visible:ring-primary"
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="cursor-pointer rounded-full p-2 text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <motion.nav
            aria-label="Mobile"
            className="overflow-hidden border-t border-hairline bg-ground md:hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28 }}
          >
            <div className="flex flex-col gap-5 px-5 py-6">
              {LINKS.map((l) => (
                <NavLink key={l.to} to={l.to} className={linkClass} onClick={() => setOpen(false)}>
                  {l.label}
                </NavLink>
              ))}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate('/clinic/login?mode=register');
                }}
                className="cursor-pointer text-left font-ui text-[10.5px] font-medium uppercase tracking-[0.12em] text-primary"
              >
                Register your clinic
              </button>
            </div>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}
