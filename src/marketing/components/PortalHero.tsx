import { CalendarCheck, FileText, HeartPulse, Pill, QrCode, ShieldCheck, Stethoscope, Ticket } from 'lucide-react';
import { motion, useMotionValue, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { Label } from './motionKit';

// ---------------------------------------------------------------------------
// The closed state is not a blank page: behind the wordmark, colour drifts,
// waves ripple out, glass icons orbit and particles rise. It fades away as the
// panels open (it is driven by the same scroll position), so it never competes
// with the photograph.
// ---------------------------------------------------------------------------
const CHIPS = [
  { Icon: Stethoscope, ring: 0, angle: 0 },
  { Icon: CalendarCheck, ring: 0, angle: 120 },
  { Icon: HeartPulse, ring: 0, angle: 240 },
  { Icon: QrCode, ring: 1, angle: 40 },
  { Icon: Pill, ring: 1, angle: 130 },
  { Icon: ShieldCheck, ring: 1, angle: 220 },
  { Icon: FileText, ring: 1, angle: 305 },
  { Icon: Ticket, ring: 0, angle: 300 },
];
const DOTS = Array.from({ length: 28 }, (_, i) => ({
  left: (i * 41 + 9) % 100,
  size: 3 + ((i * 7) % 4),
  duration: 9 + ((i * 5) % 9),
  delay: -((i * 3) % 12),
  drift: ((i * 17) % 50) - 25,
  emerald: i % 3 === 0,
}));

function HeroAmbient() {
  return (
    <>
      <motion.div
        className="absolute -left-40 -top-40 h-[42rem] w-[42rem] rounded-full blur-3xl"
        style={{ background: 'rgba(59,91,219,0.22)' }}
        animate={{ x: [0, 120, 0], y: [0, 70, 0], scale: [1, 1.2, 1] }}
        transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -bottom-48 -right-32 h-[40rem] w-[40rem] rounded-full blur-3xl"
        style={{ background: 'rgba(16,185,129,0.22)' }}
        animate={{ x: [0, -110, 0], y: [0, -60, 0], scale: [1.1, 0.95, 1.1] }}
        transition={{ duration: 19, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute left-1/3 top-1/4 h-[28rem] w-[28rem] rounded-full blur-3xl"
        style={{ background: 'rgba(224,235,255,0.9)' }}
        animate={{ x: [0, 80, -40, 0], y: [0, 50, 90, 0] }}
        transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="absolute inset-0 opacity-60 [background-image:radial-gradient(rgba(59,91,219,0.22)_1px,transparent_1px)] [background-size:34px_34px] [mask-image:radial-gradient(ellipse_at_center,black_25%,transparent_72%)]" />

      {/* sonar waves from the centre, alternating indigo and emerald */}
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={`wave-${i}`}
          className="absolute left-1/2 top-1/2 rounded-full border-2"
          style={{
            width: 'min(46vw, 46vh)',
            height: 'min(46vw, 46vh)',
            marginLeft: 'calc(min(46vw, 46vh) / -2)',
            marginTop: 'calc(min(46vw, 46vh) / -2)',
            borderColor: i % 2 ? 'rgba(16,185,129,0.55)' : 'rgba(59,91,219,0.5)',
          }}
          initial={{ scale: 0.3, opacity: 0 }}
          animate={{ scale: [0.3, 2.3], opacity: [0.6, 0] }}
          transition={{ duration: 8, delay: i * 2, repeat: Infinity, ease: 'easeOut' }}
        />
      ))}

      {/* two orbits of glass icons */}
      {[0, 1].map((ring) => (
        <motion.div
          key={`orbit-${ring}`}
          className="absolute left-1/2 top-1/2 h-0 w-0"
          animate={{ rotate: ring ? -360 : 360 }}
          transition={{ duration: ring ? 60 : 44, ease: 'linear', repeat: Infinity }}
        >
          {CHIPS.filter((c) => c.ring === ring).map(({ Icon, angle }, i) => {
            const radius = ring ? 'min(40vw, 44vh)' : 'min(27vw, 31vh)';
            return (
              <div key={i} className="absolute left-0 top-0" style={{ transform: `rotate(${angle}deg) translateX(${radius})` }}>
                <motion.div
                  className="-ml-6 -mt-6 flex h-12 w-12 items-center justify-center rounded-full border border-white/80 bg-white/70 text-primary shadow-xl shadow-indigo-500/20 backdrop-blur-md"
                  initial={{ rotate: -angle }}
                  animate={{ rotate: ring ? -angle + 360 : -angle - 360 }}
                  transition={{ duration: ring ? 60 : 44, ease: 'linear', repeat: Infinity }}
                >
                  <motion.span
                    className="flex"
                    animate={{ scale: [1, 1.18, 1] }}
                    transition={{ duration: 3, delay: i * 0.6, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    <Icon size={20} strokeWidth={1.75} />
                  </motion.span>
                </motion.div>
              </div>
            );
          })}
        </motion.div>
      ))}

      {DOTS.map((d, i) => (
        <motion.span
          key={i}
          className="absolute rounded-full"
          style={{ left: `${d.left}%`, bottom: -10, width: d.size, height: d.size, background: d.emerald ? '#10b981' : '#3b5bdb' }}
          animate={{ y: [0, -1100], x: [0, d.drift], opacity: [0, 0.7, 0.7, 0] }}
          transition={{ duration: d.duration, delay: d.delay, repeat: Infinity, ease: 'linear', times: [0, 0.1, 0.85, 1] }}
        />
      ))}
    </>
  );
}

// Each letter springs up in turn when the page loads.
function Letters({ text, start = 0, gradient = false }: { text: string; start?: number; gradient?: boolean }) {
  return (
    <>
      {[...text].map((ch, i) => (
        <motion.span
          key={i}
          className={`inline-block ${gradient ? 'bg-clip-text text-transparent' : ''}`}
          style={
            gradient
              ? { backgroundImage: 'linear-gradient(100deg, #5c7cfa 0%, #34d399 45%, #5c7cfa 90%)', backgroundSize: '220% 100%' }
              : undefined
          }
          initial={{ y: '0.7em', opacity: 0, rotate: 6 }}
          animate={
            gradient
              ? { y: 0, opacity: 1, rotate: 0, backgroundPosition: ['0% 50%', '220% 50%'] }
              : { y: 0, opacity: 1, rotate: 0 }
          }
          transition={{
            y: { type: 'spring', stiffness: 220, damping: 16, delay: 0.15 + (start + i) * 0.055 },
            opacity: { duration: 0.4, delay: 0.15 + (start + i) * 0.055 },
            rotate: { type: 'spring', stiffness: 220, damping: 16, delay: 0.15 + (start + i) * 0.055 },
            backgroundPosition: { duration: 5, repeat: Infinity, ease: 'linear' },
          }}
        >
          {ch}
        </motion.span>
      ))}
    </>
  );
}

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
  const labelColor = useTransform(p, [0.12, 0.5], ['#6b7280', 'rgba(255,255,255,0.8)']);

  const copyOpacity = useTransform(p, [0.5, 0.82], [0, 1]);
  const copyPointer = useTransform(p, (v) => (v > 0.7 ? 'auto' : 'none'));
  const hintOpacity = useTransform(p, [0, 0.12], [1, 0]);
  const ambientOpacity = useTransform(p, [0, 0.32], [1, 0]);

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

        {/* 4b. living colour behind the wordmark (fades out as the panels open) */}
        {!reduce && (
          <motion.div aria-hidden className="pointer-events-none absolute inset-0 -z-[15] overflow-hidden" style={{ opacity: ambientOpacity }}>
            <HeroAmbient />
          </motion.div>
        )}

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
              <Letters text="Sanjee" />
            </motion.span>
            <motion.span className="inline-block" style={{ x: lastX }}>
              <Letters text="vni" start={6} />
              <Letters text="OS" start={9} gradient />
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
            <div className="flex flex-col items-center gap-2">
              <span className="flex h-9 w-6 items-start justify-center rounded-full border-2 border-ink/40 pt-1.5">
                <motion.span
                  className="h-1.5 w-1 rounded-full bg-primary"
                  animate={{ y: [0, 12, 0], opacity: [1, 0.2, 1] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                />
              </span>
              <Label className="!text-ink-2">Scroll</Label>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
