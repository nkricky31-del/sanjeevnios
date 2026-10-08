import { motion, useMotionValue, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { Label } from './motionKit';

// The hero is a portal. A tall section holds a sticky full-height stage; as the
// reader scrolls, two solid panels part outward to uncover the photograph while
// the wordmark grows, its tracking tightens and its two halves travel toward
// opposite edges. Everything below is bound to scroll POSITION (not a timer),
// so it plays in reverse on the way back up.
//
// Layers, back to front: photo (starts overscaled) -> duotone wash (indigo+emerald,
// overlay blend, starts at 0) -> radial veil -> two panels -> two accent dots
// -> wordmark -> corner metadata. With prefers-reduced-motion the stage is
// simply rendered in its finished, opened state.
export default function PortalHero() {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const finished = useMotionValue(1);
  const p = reduce ? finished : scrollYProgress;

  // 0 -> 1 while the panels clear the frame (done a little past halfway).
  const open = useTransform(p, [0, 0.55], [0, 1]);
  const leftX = useTransform(open, (v) => `${-v * 106}%`);
  const rightX = useTransform(open, (v) => `${v * 106}%`);

  const photoScale = useTransform(p, [0, 0.7], [1.14, 1]);
  const washOpacity = useTransform(p, [0, 0.7], [0, 0.3]);

  // Two dots at the centre travel to opposite corners of the field.
  const dotAX = useTransform(open, (v) => `${-v * 42}vw`);
  const dotAY = useTransform(open, (v) => `${-v * 36}vh`);
  const dotBX = useTransform(open, (v) => `${v * 42}vw`);
  const dotBY = useTransform(open, (v) => `${v * 36}vh`);

  // The title: grow AND tighten at the same time (one without the other reads
  // as a plain zoom), with the halves sliding apart. Amounts picked for Syne,
  // a wide geometric face, so the tracking only tightens modestly.
  const titleScale = useTransform(p, [0, 1], [1, 1.12]);
  const titleTracking = useTransform(p, [0, 1], ['-0.01em', '-0.05em']);
  const firstX = useTransform(p, [0, 1], ['0%', '-30%']);
  const lastX = useTransform(p, [0, 1], ['0%', '30%']);

  // Ink on the white panels, white once the photograph is uncovered.
  const textColor = useTransform(p, [0.12, 0.5], ['#111827', '#ffffff']);
  // The indigo "OS" lifts to a lighter indigo against the photograph.
  const accentColor = useTransform(p, [0.12, 0.5], ['#3b5bdb', '#9db4ff']);
  const labelColor = useTransform(p, [0.12, 0.5], ['#6b7280', 'rgba(255,255,255,0.8)']);

  const copyOpacity = useTransform(p, [0.5, 0.82], [0, 1]);
  const copyPointer = useTransform(p, (v) => (v > 0.7 ? 'auto' : 'none'));
  const hintOpacity = useTransform(p, [0, 0.12], [1, 0]);

  return (
    <section ref={ref} className={`relative bg-ground ${reduce ? 'h-[100svh]' : 'h-[250vh]'}`}>
      <div className="sticky top-0 isolate h-[100svh] overflow-hidden">
        {/* 1. photograph */}
        <motion.img
          src="/img/hero-doctor.jpg"
          alt="A doctor in a white coat and stethoscope holding a phone"
          className="absolute inset-0 -z-50 h-full w-full object-cover"
          style={{ scale: photoScale }}
          fetchPriority="high"
        />
        {/* 2. duotone wash: the two accents, blended, at near-zero opacity */}
        <motion.div
          aria-hidden
          className="absolute inset-0 -z-40 mix-blend-overlay"
          style={{ opacity: washOpacity, background: 'linear-gradient(135deg, var(--color-primary), var(--color-leaf))' }}
        />
        {/* 3. radial veil darkening the edges */}
        <div
          aria-hidden
          className="absolute inset-0 -z-30"
          style={{ background: 'radial-gradient(120% 90% at 50% 45%, rgba(17,24,39,.25) 0%, rgba(17,24,39,.82) 100%)' }}
        />

        {/* 4. the two panels, a little over half the width each so they meet and
               the hero begins CLOSED */}
        <motion.div aria-hidden className="absolute inset-y-0 left-0 -z-20 w-[51%] bg-ground-2" style={{ x: leftX }} />
        <motion.div aria-hidden className="absolute inset-y-0 right-0 -z-20 w-[51%] bg-ground-2" style={{ x: rightX }} />

        {/* 5. accent dots */}
        <motion.span
          aria-hidden
          className="absolute left-1/2 top-1/2 -z-10 -ml-1 -mt-1 h-2 w-2 rounded-full bg-primary"
          style={{ x: dotAX, y: dotAY }}
        />
        <motion.span
          aria-hidden
          className="absolute left-1/2 top-1/2 -z-10 -ml-1 -mt-1 h-2 w-2 rounded-full bg-leaf"
          style={{ x: dotBX, y: dotBY }}
        />

        {/* 6. the wordmark, split into two spans on one line */}
        <div className="absolute inset-0 flex items-center justify-center">
          <motion.h1
            className="flex whitespace-nowrap font-display text-[clamp(2.25rem,10vw,10rem)] font-extrabold leading-none will-change-transform"
            style={{ scale: titleScale, letterSpacing: titleTracking, color: reduce ? '#ffffff' : textColor }}
          >
            <motion.span className="inline-block" style={{ x: firstX }}>
              Sanjee
            </motion.span>
            <motion.span className="inline-block" style={{ x: lastX }}>
              vni<motion.span style={{ color: reduce ? '#9db4ff' : accentColor }}>OS</motion.span>
            </motion.span>
            <span className="sr-only"> - clinic bookings, queues and records</span>
          </motion.h1>
        </div>

        {/* corner metadata, pinned to the top and bottom edges */}
        <div className="pointer-events-none absolute inset-x-0 top-[74px] flex justify-between px-5">
          <motion.div style={{ color: reduce ? 'rgba(255,255,255,0.8)' : labelColor }}><Label className="!text-current">Verified clinics &amp; doctors</Label></motion.div>
          <motion.div style={{ color: reduce ? 'rgba(255,255,255,0.8)' : labelColor }}><Label className="!text-current">India</Label></motion.div>
        </div>
        <div className="absolute inset-x-0 bottom-0 px-5 pb-6">
          <motion.div
            className="mx-auto max-w-6xl text-center sm:text-left"
            style={{ opacity: copyOpacity, pointerEvents: copyPointer }}
          >
            <p className="mx-auto max-w-md font-ui text-base leading-relaxed text-white sm:mx-0 sm:text-lg">
              Book a clinic visit, or run one. One live queue, one record, one platform behind the appointment.
            </p>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="cursor-pointer rounded-full bg-primary px-6 py-3 font-ui text-sm font-semibold text-white outline-none transition hover:bg-primary-dark focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
              >
                Book a visit
              </button>
              <button
                type="button"
                onClick={() => navigate('/clinic/login?mode=register')}
                className="cursor-pointer rounded-full border border-white/60 px-6 py-3 font-ui text-sm font-semibold text-white outline-none transition hover:bg-white hover:text-ink focus-visible:ring-2 focus-visible:ring-white"
              >
                Register your clinic
              </button>
            </div>
          </motion.div>
          <motion.div
            aria-hidden
            className="absolute inset-x-0 bottom-6 flex justify-center"
            style={{ opacity: reduce ? 0 : hintOpacity }}
          >
            <Label className="!text-ink-2">Scroll</Label>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
