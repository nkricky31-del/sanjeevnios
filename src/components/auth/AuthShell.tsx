import { motion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import BrandMark from '../ui/BrandMark';
import Wordmark from '../ui/Wordmark';
import { useDarkBackdrop } from '../../lib/useDarkBackdrop';
import { AUTH_THEMES, type AuthRole, type AuthTheme } from './authThemes';

const EASE = [0.22, 1, 0.36, 1] as const;

// Deterministic "random" so the particles sit in the same places on every render.
const PARTICLES = Array.from({ length: 26 }, (_, i) => ({
  left: (i * 37 + 11) % 100,
  size: 2 + ((i * 5) % 4),
  duration: 9 + ((i * 7) % 9),
  delay: -((i * 3) % 11),
  drift: ((i * 13) % 40) - 20,
}));

// The animated side panel. Deep role-coloured gradient, then (back to front):
// drifting colour blobs, a fine dot grid, sonar waves rising from the centre, a
// slow radar sweep, glowing rings, glass icons on three orbits, floating
// particles, and the word. All motion transforms, so prefers-reduced-motion
// (MotionConfig in main.tsx) holds the whole thing still.
// The moving picture itself, positioned around the centre of whatever contains
// it. Used full-size on a laptop and scaled down in the phone's top band.
function StageArt({ theme }: { theme: AuthTheme }) {
  const { stage } = theme;
  const ringStyle = theme.ring === 'solid' ? 'border-solid' : theme.ring === 'dashed' ? 'border-dashed' : 'border-dotted';
  const glow = `0 0 22px ${stage.light}66, inset 0 0 12px ${stage.light}22`;
  return (
    <>
      {/* drifting colour */}
      <motion.div
        className="absolute -left-32 -top-32 h-[34rem] w-[34rem] rounded-full blur-3xl"
        style={{ background: stage.blobA }}
        animate={{ x: [0, 90, 0], y: [0, 60, 0], scale: [1, 1.18, 1] }}
        transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -bottom-40 -right-24 h-[32rem] w-[32rem] rounded-full blur-3xl"
        style={{ background: stage.blobB }}
        animate={{ x: [0, -80, 0], y: [0, -50, 0], scale: [1.1, 0.95, 1.1] }}
        transition={{ duration: 17, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* fine dot grid, fading out towards the edges */}
      <div
        className="absolute inset-0 opacity-60 [background-image:radial-gradient(rgba(255,255,255,0.16)_1px,transparent_1px)] [background-size:30px_30px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_72%)]"
      />

      {/* sonar waves: rings that grow out of the centre and fade */}
      {[0, 1, 2].map((i) => (
        <motion.span
          key={`wave-${i}`}
          className="absolute left-1/2 top-1/2 -ml-[210px] -mt-[210px] h-[420px] w-[420px] rounded-full border-2"
          style={{ borderColor: stage.light }}
          initial={{ scale: 0.35, opacity: 0 }}
          animate={{ scale: [0.35, 1.9], opacity: [0.55, 0] }}
          transition={{ duration: 6.5, delay: i * 2.15, repeat: Infinity, ease: 'easeOut' }}
        />
      ))}

      {/* radar sweep (leaves the centre clear for the word) */}
      <motion.div
        className="absolute left-1/2 top-1/2 -ml-[300px] -mt-[300px] h-[600px] w-[600px] rounded-full"
        style={{
          background: `conic-gradient(from 0deg, transparent 0deg, ${stage.light}00 250deg, ${stage.light}55 330deg, ${stage.light}00 360deg)`,
          maskImage: 'radial-gradient(circle, transparent 36%, black 37%, black 100%)',
          WebkitMaskImage: 'radial-gradient(circle, transparent 36%, black 37%, black 100%)',
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: 9, ease: 'linear', repeat: Infinity }}
      />

      {/* orbit rings */}
      {[0, 1, 2].map((i) => {
        const size = theme.orbits[i].radius * 2;
        return (
          <span
            key={`ring-${i}`}
            className={`absolute left-1/2 top-1/2 rounded-full border ${ringStyle}`}
            style={{ width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, borderColor: 'rgba(255,255,255,0.20)' }}
          />
        );
      })}

      {/* orbiting glass icons */}
      {theme.orbits.map((orbit, oi) => {
        const duration = 22 + oi * 12;
        return (
          <motion.div
            key={oi}
            className="absolute left-1/2 top-1/2 h-0 w-0"
            animate={{ rotate: orbit.reverse ? -360 : 360 }}
            transition={{ duration, ease: 'linear', repeat: Infinity }}
          >
            {orbit.icons.map((Icon, ii) => {
              const angle = (360 / orbit.icons.length) * ii + oi * 40;
              return (
                <div key={ii} className="absolute left-0 top-0" style={{ transform: `rotate(${angle}deg) translateX(${orbit.radius}px)` }}>
                  <motion.div
                    className="-ml-[23px] -mt-[23px] flex h-[46px] w-[46px] items-center justify-center rounded-full border border-white/30 bg-white/10 backdrop-blur-md"
                    style={{ color: '#ffffff', boxShadow: glow }}
                    initial={{ rotate: -angle }}
                    animate={{ rotate: orbit.reverse ? -angle + 360 : -angle - 360 }}
                    transition={{ duration, ease: 'linear', repeat: Infinity }}
                  >
                    <motion.span
                      className="flex"
                      animate={{ scale: [1, 1.18, 1] }}
                      transition={{ duration: 3.2, delay: ii * 0.7 + oi * 0.4, repeat: Infinity, ease: 'easeInOut' }}
                    >
                      <Icon size={19} strokeWidth={1.75} />
                    </motion.span>
                  </motion.div>
                </div>
              );
            })}
          </motion.div>
        );
      })}

      {/* floating particles */}
      {PARTICLES.map((pt, i) => (
        <motion.span
          key={i}
          className="absolute rounded-full"
          style={{ left: `${pt.left}%`, bottom: -10, width: pt.size, height: pt.size, background: stage.light }}
          animate={{ y: [0, -1000], x: [0, pt.drift], opacity: [0, 0.9, 0.9, 0] }}
          transition={{ duration: pt.duration, delay: pt.delay, repeat: Infinity, ease: 'linear', times: [0, 0.1, 0.85, 1] }}
        />
      ))}
    </>
  );
}

function Stage({ theme }: { theme: AuthTheme }) {
  const { stage } = theme;
  return (
    <div className="relative hidden min-h-screen flex-1 overflow-hidden lg:block" style={{ background: stage.bg }} aria-hidden>
      <StageArt theme={theme} />

      {/* the word at the centre */}
      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center text-center">
        <motion.p
          className="font-ui text-[10.5px] font-medium uppercase tracking-[0.3em] text-white/70"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2 }}
        >
          SanjeevniOS
        </motion.p>
        <motion.p
          className="mt-3 font-display text-6xl font-extrabold leading-none tracking-[-0.03em] text-white drop-shadow-[0_6px_30px_rgba(0,0,0,0.35)] xl:text-7xl"
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.9, delay: 0.3, ease: EASE }}
        >
          {theme.word}
          <span style={{ color: stage.light }}>.</span>
        </motion.p>
      </div>

      {/* headline pinned bottom-left */}
      <motion.div
        className="absolute inset-x-10 bottom-10 z-10"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.7, ease: EASE }}
      >
        <p className="font-display text-3xl font-bold leading-[1.05] tracking-[-0.02em] text-white">
          {theme.headline[0]}
          <br />
          <span style={{ color: stage.light }}>{theme.headline[1]}</span>
        </p>
        <p className="mt-3 max-w-sm font-ui text-sm leading-relaxed text-white/75">{theme.blurb}</p>
      </motion.div>
    </div>
  );
}

// The phone version of the stage: the same picture, scaled to fit a band across
// the top of the screen, with the word and tagline over it.
function MobileBand({ theme }: { theme: AuthTheme }) {
  const { stage } = theme;
  return (
    <div className="relative h-[17.5rem] shrink-0 overflow-hidden lg:hidden" style={{ background: stage.bg }}>
      <div aria-hidden className="absolute left-[66%] top-1/2 -ml-[350px] -mt-[350px] h-[700px] w-[700px] scale-[0.5] sm:left-[60%] sm:scale-[0.6]">
        <StageArt theme={theme} />
      </div>
      <div className="absolute inset-x-5 top-5 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 font-display text-[15px] font-bold tracking-[-0.02em] text-white" aria-label="SanjeevniOS home">
          <BrandMark size={30} tone="light" />
          <Wordmark dotClassName="" dotColor={stage.light} />
        </Link>
        <span className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 font-ui text-[10px] font-medium uppercase tracking-[0.16em] text-white/85 ring-1 ring-white/20 backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: stage.light }} />
          {theme.tag}
        </span>
      </div>
      <motion.div
        className="absolute inset-x-5 bottom-14"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.2, ease: EASE }}
      >
        <p className="font-display text-5xl font-extrabold leading-none tracking-[-0.03em] text-white drop-shadow-[0_6px_24px_rgba(0,0,0,0.35)]">
          {theme.word}
          <span style={{ color: stage.light }}>.</span>
        </p>
        <p className="mt-2 max-w-xs font-ui text-sm leading-snug text-white/80">
          {theme.headline[0]} <span style={{ color: stage.light }}>{theme.headline[1]}</span>
        </p>
      </motion.div>
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
      className="flex min-h-screen flex-col bg-ground font-ui text-ink lg:flex-row"
      style={{ '--accent': theme.accent } as CSSProperties}
      data-auth-role={role}
    >
      <MobileBand theme={theme} />
      <Stage theme={theme} />

      <main className="relative z-10 -mt-8 flex w-full flex-1 flex-col justify-start rounded-t-[2rem] bg-ground px-5 pb-10 pt-8 sm:px-10 lg:mt-0 lg:w-[34rem] lg:flex-none lg:justify-center lg:rounded-none lg:py-10 xl:w-[38rem] xl:px-16">
        <div className="mx-auto w-full max-w-sm">
          <motion.div
            className="hidden lg:block"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <Link to="/" className="flex w-fit items-center gap-2.5" aria-label="SanjeevniOS home">
              <BrandMark size={34} />
              <span className="font-display text-[15px] font-bold tracking-[-0.02em]">
                <Wordmark dotClassName="text-[var(--accent)]" />
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
