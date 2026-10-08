import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { useRef } from 'react';

import { Label, Reveal } from './motionKit';

// A full-height fold: a label, one big statement with a single amber phrase,
// an outlined index numeral, and a circular image floating off the right edge
// at reduced opacity that drifts and turns slowly as you scroll.
export default function StatementFold() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], reduce ? [0, 0] : [90, -90]);
  const rotate = useTransform(scrollYProgress, [0, 1], reduce ? [0, 0] : [-12, 22]);

  return (
    <section ref={ref} className="relative flex min-h-[100svh] items-center overflow-hidden bg-ground">
      <motion.div
        aria-hidden
        className="absolute -right-[22vw] top-1/2 -mt-[22vw] h-[44vw] min-h-[260px] w-[44vw] min-w-[260px] overflow-hidden rounded-full opacity-30"
        style={{ y, rotate }}
      >
        <img src="/img/anatomy-heart.jpg" alt="" className="h-full w-full object-cover" loading="lazy" />
      </motion.div>

      <div className="relative mx-auto w-full max-w-6xl px-5 py-24">
        <Reveal>
          <Label accent="teal">The problem</Label>
        </Reveal>
        <Reveal delay={0.08}>
          <p className="mt-6 max-w-[22ch] font-display text-[clamp(24px,3.6vw,52px)] font-bold leading-[1.12] tracking-[-0.02em] text-ink">
            A clinic's front desk and a patient's phone should show <span className="text-amber">the same queue.</span>
          </p>
        </Reveal>
        <Reveal delay={0.16}>
          <p className="mt-6 max-w-md font-ui text-base leading-relaxed text-ink-2">
            So we built one system both sides share. The token a patient sees is the token the front desk just issued,
            and the prescription a doctor writes is the one in the patient's records.
          </p>
        </Reveal>
        <p
          aria-hidden
          className="mt-14 select-none font-display text-[clamp(96px,16vw,220px)] font-extrabold leading-none tracking-[-0.04em] text-transparent [-webkit-text-stroke:1px_rgb(237_231_220/0.35)]"
        >
          01
        </p>
      </div>
    </section>
  );
}
