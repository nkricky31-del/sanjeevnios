import { Building2, HeartPulse, LogIn, Mail, Rocket, Sparkles, User, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import BrandMark from '../../components/ui/BrandMark';
import Wordmark from '../../components/ui/Wordmark';
import { goToSection } from '../lib/sectionNav';
import { Reveal } from './motionKit';
import BrandName from '../../components/ui/BrandName';

type FooterLink = { label: string; to?: string; section?: string; Icon: LucideIcon; from: string; to2: string };
const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Product',
    links: [
      { section: 'for-patients', label: 'For patients', Icon: HeartPulse, from: '#6366f1', to2: '#38bdf8' },
      { section: 'for-clinics', label: 'For clinics', Icon: Building2, from: '#10b981', to2: '#a3e635' },
    ],
  },
  {
    title: 'Company',
    links: [
      { section: 'about', label: 'About', Icon: Sparkles, from: '#f59e0b', to2: '#f43f5e' },
      { section: 'contact', label: 'Contact', Icon: Mail, from: '#0ea5e9', to2: '#14b8a6' },
    ],
  },
  {
    title: 'Account',
    links: [
      { to: '/login', label: 'Patient sign in', Icon: User, from: '#8b5cf6', to2: '#ec4899' },
      { to: '/clinic/login', label: 'Clinic sign in', Icon: LogIn, from: '#6366f1', to2: '#0ea5e9' },
      { to: '/clinic/login?mode=register', label: 'Register your clinic', Icon: Rocket, from: '#ec4899', to2: '#f59e0b' },
    ],
  },
];

// A hairline strip of links, then the wordmark at full width, nudged down so
// the bottom edge of the page crops it.
export default function MarketingFooter() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <footer className="overflow-hidden border-t border-hairline bg-ground">
      <div className="mx-auto max-w-6xl px-5 pt-12">
        <Link to="/" className="mb-8 flex w-fit items-center gap-2.5 font-display text-lg font-bold tracking-[-0.02em] text-ink">
          <BrandMark size={34} />
          <Wordmark />
        </Link>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {COLUMNS.map((c, ci) => (
            <Reveal key={c.title} delay={ci * 0.08} y={16}>
              <p className="font-ui text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">{c.title}</p>
              <div className="mt-3 flex flex-col gap-2">
                {c.links.map((l) => {
                  const inner = (
                    <>
                      <motion.span
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-white shadow-sm"
                        style={{ background: `linear-gradient(135deg, ${l.from}, ${l.to2})` }}
                        variants={{ rest: { rotate: 0, scale: 1 }, hover: { rotate: [0, -12, 10, 0], scale: 1.18 } }}
                      >
                        <l.Icon size={14} />
                      </motion.span>
                      <span className="relative">
                        {l.label}
                        <span
                          className="absolute -bottom-0.5 left-0 h-0.5 w-full origin-left scale-x-0 rounded-full transition-transform duration-300 group-hover:scale-x-100"
                          style={{ background: `linear-gradient(90deg, ${l.from}, ${l.to2})` }}
                        />
                      </span>
                    </>
                  );
                  const cls = 'group flex w-fit items-center gap-2.5 font-ui text-sm text-ink-2 outline-none transition-all duration-300 hover:translate-x-1.5 hover:text-ink focus-visible:text-ink';
                  return l.to ? (
                    <motion.div key={l.label} initial="rest" whileHover="hover"><Link to={l.to} className={cls}>{inner}</Link></motion.div>
                  ) : (
                    <motion.div key={l.label} initial="rest" whileHover="hover">
                      <a
                        href={`/#${l.section}`}
                        onClick={(e) => { e.preventDefault(); goToSection(l.section!, pathname, navigate); }}
                        className={cls}
                      >
                        {inner}
                      </a>
                    </motion.div>
                  );
                })}
              </div>
            </Reveal>
          ))}
        </div>
        <p className="mt-10 border-t border-hairline pt-5 font-ui text-xs text-muted">
          © {new Date().getFullYear()} <BrandName />. All rights reserved.
        </p>
      </div>
      <p
        aria-hidden
        className="hue-text mx-auto mt-6 select-none whitespace-nowrap pb-[0.12em] text-center font-display text-[9vw] font-extrabold leading-[1.05] tracking-[-0.04em]"
      >
        SanjeevniOS
      </p>
    </footer>
  );
}
