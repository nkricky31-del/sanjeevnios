import { motion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import BrandMark from '../ui/BrandMark';
import { useDarkBackdrop } from '../../lib/useDarkBackdrop';
import { AUTH_THEMES, type AuthRole, type AuthTheme } from './authThemes';

const EASE = [0.22, 1, 0.36, 1] as const;

// Concentric rings that breathe, plus icons orbiting on three paths. All of it
// is motion transforms, so prefers-reduced-motion (MotionConfig in main.tsx)
// freezes it into a still picture.
function Stage({ theme }: { theme: AuthTheme }) {
  const ringStyle = theme.ring === 'solid' ? 'border-solid' : theme.ring === 'dashed' ? 'border-dashed' : 'border-dotted';
  return (
    <div className="relative hidden min-h-screen flex-1 overflow-hidden border-r border-hairline bg-ground-2 lg:block" aria-hidden>
      {/* breathing rings */}
      {[0, 1, 2, 3].map((i) => {
        const size = 220 + i * 140;
        return (
          <motion.span
            key={i}
            className={`absolute left-1/2 top-1/2 rounded-full border border-ink/10 ${ringStyle}`}
            style={{ width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2 }}
            animate={{ scale: [1, 0.94, 1], opacity: [0.9 - i * 0.18, 0.5 - i * 0.1, 0.9 - i * 0.18] }}
            transition={{ duration: 6, delay: i * 0.5, repeat: Infinity, ease: 'easeInOut' }}
          />
        );
      })}

      {/* orbits */}
      {theme.orbits.map((orbit, oi) => (
        <motion.div
          key={oi}
          className="absolute left-1/2 top-1/2 h-0 w-0"
          animate={{ rotate: orbit.reverse ? -360 : 360 }}
          transition={{ duration: orbit.duration, ease: 'linear', repeat: Infinity }}
        >
          {orbit.icons.map((Icon, ii) => {
            const angle = (360 / orbit.icons.length) * ii + oi * 40;
            return (
              <div
                key={ii}
                className="absolute left-0 top-0"
                style={{ transform: `rotate(${angle}deg) translateX(${orbit.radius}px)` }}
              >
                {/* counter-rotate so the icon stays upright while its orbit turns */}
                <motion.div
                  className="-ml-[18px] -mt-[18px] flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-ground text-[var(--accent)]"
                  initial={{ rotate: -angle }}
                  animate={{ rotate: orbit.reverse ? -angle + 360 : -angle - 360 }}
                  transition={{ duration: orbit.duration, ease: 'linear', repeat: Infinity }}
                >
                  <Icon size={16} strokeWidth={1.75} />
                </motion.div>
              </div>
            );
          })}
        </motion.div>
      ))}

      {/* the word at the centre */}
      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center text-center">
        <p className="font-ui text-[10.5px] font-medium uppercase tracking-[0.15em] text-ink-2">SanjeevniOS</p>
        <p className="mt-3 font-display text-6xl font-extrabold leading-none tracking-[-0.03em] text-ink xl:text-7xl">
          {theme.word}
          <span className="text-[var(--accent)]">.</span>
        </p>
      </div>

      {/* headline pinned bottom-left */}
      <div className="absolute inset-x-10 bottom-10">
        <p className="font-display text-3xl font-bold leading-[1.05] tracking-[-0.02em] text-ink">
          {theme.headline[0]}
          <br />
          <span className="text-[var(--accent)]">{theme.headline[1]}</span>
        </p>
        <p className="mt-3 max-w-sm font-ui text-sm leading-relaxed text-ink-2">{theme.blurb}</p>
      </div>
    </div>
  );
}

// Shared frame for the patient, clinic and admin sign-in screens: the animated
// stage on the left (desktop), the form column on the right. The role decides
// the accent, words, icons and ring style - everything else is identical.
export default function AuthShell({
  role,
  children,
  aside,
}: {
  role: AuthRole;
  children: ReactNode;
  /** Small links under the card (e.g. "Admin", "Back to patient login"). */
  aside?: ReactNode;
}) {
  const theme = AUTH_THEMES[role];
  useDarkBackdrop();
  return (
    <div
      className="flex min-h-screen bg-ground font-ui text-ink"
      style={{ '--accent': theme.accent } as CSSProperties}
      data-auth-role={role}
    >
      <Stage theme={theme} />

      <main className="flex w-full flex-col justify-center px-5 py-10 sm:px-10 lg:w-[34rem] lg:flex-none xl:w-[38rem] xl:px-16">
        <div className="mx-auto w-full max-w-sm">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <Link to="/" className="flex w-fit items-center gap-2.5" aria-label="SanjeevniOS home">
              <BrandMark size={30} />
              <span className="font-display text-[15px] font-bold tracking-[-0.02em]">
                SanjeevniOS<span className="text-[var(--accent)]">.</span>
              </span>
            </Link>
            <p className="mt-5 flex items-center gap-2 font-ui text-[10.5px] font-medium uppercase tracking-[0.15em] text-ink-2">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              {theme.tag}
            </p>
          </motion.div>

          <motion.div
            className="mt-6 rounded-2xl border border-hairline bg-ground-2 p-6"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.08, ease: EASE }}
          >
            {children}
          </motion.div>

          <motion.ul
            className="mt-6 grid grid-cols-3 gap-2 text-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.3 }}
          >
            {theme.badges.map((b) => (
              <li key={b.lines.join()} className="flex flex-col items-center gap-1.5">
                <b.icon size={18} strokeWidth={1.75} className="text-[var(--accent)]" />
                <span className="text-[11px] leading-tight text-ink-2">
                  {b.lines[0]}
                  <br />
                  {b.lines[1]}
                </span>
              </li>
            ))}
          </motion.ul>

          {aside && <div className="mt-8 text-center text-xs text-ink-2">{aside}</div>}
        </div>
      </main>
    </div>
  );
}
