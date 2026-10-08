import { motion } from 'motion/react';
import type { ReactNode } from 'react';

// Deterministic "random" so particles sit in the same places on every render.
const PARTICLES = Array.from({ length: 16 }, (_, i) => ({
  left: (i * 53 + 7) % 100,
  size: 2 + ((i * 3) % 3),
  duration: 7 + ((i * 5) % 7),
  delay: -((i * 2) % 9),
  drift: ((i * 11) % 30) - 15,
}));

// The animated banner at the top of every screen in the signed-in apps. It
// takes the role's colour (indigo / emerald / slate) and carries the same
// moving ingredients as the sign-in panel: drifting colour, sonar waves, rising
// particles. Edge-to-edge with a rounded foot on a phone, a rounded card on a
// laptop. All motion transforms, so reduced-motion holds it still.
export default function HeroBand({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`relative isolate mb-4 overflow-hidden rounded-b-[2rem] px-4 pb-7 pt-7 text-white sm:px-6 lg:mx-4 lg:mt-4 lg:rounded-3xl lg:px-8 lg:pb-9 lg:pt-9 ${className}`}
      style={{ background: 'var(--band-bg)' }}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <motion.div
          className="absolute -left-20 -top-24 h-72 w-72 rounded-full blur-3xl"
          style={{ background: 'var(--sidebar-glow)' }}
          animate={{ x: [0, 70, 0], y: [0, 30, 0], scale: [1, 1.2, 1] }}
          transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute -bottom-28 right-0 h-72 w-72 rounded-full opacity-80 blur-3xl"
          style={{ background: 'var(--sidebar-glow)' }}
          animate={{ x: [0, -60, 0], y: [0, -24, 0], scale: [1.1, 0.95, 1.1] }}
          transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
        />
        <div className="absolute inset-0 opacity-50 [background-image:radial-gradient(rgba(255,255,255,0.18)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:linear-gradient(to_right,transparent,black_55%)]" />
        {/* sonar waves from the right-hand side */}
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="absolute right-[12%] top-1/2 -mr-14 -mt-14 h-28 w-28 rounded-full border-2"
            style={{ borderColor: 'var(--sidebar-light)' }}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: [0.4, 3.4], opacity: [0.5, 0] }}
            transition={{ duration: 5.5, delay: i * 1.8, repeat: Infinity, ease: 'easeOut' }}
          />
        ))}
        {PARTICLES.map((pt, i) => (
          <motion.span
            key={i}
            className="absolute rounded-full"
            style={{ left: `${pt.left}%`, bottom: -8, width: pt.size, height: pt.size, background: 'var(--sidebar-light)' }}
            animate={{ y: [0, -260], x: [0, pt.drift], opacity: [0, 0.9, 0.9, 0] }}
            transition={{ duration: pt.duration, delay: pt.delay, repeat: Infinity, ease: 'linear', times: [0, 0.1, 0.85, 1] }}
          />
        ))}
      </div>
      <div className="relative">{children}</div>
    </div>
  );
}
