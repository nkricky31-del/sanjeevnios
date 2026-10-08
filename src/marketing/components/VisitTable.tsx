import { CheckCircle2, CreditCard, FolderHeart, QrCode, Search, Stethoscope, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';

import { Label, Reveal } from './motionKit';

// One small looping scene per step, in the step's own colour.
const SCENES: Record<string, { Icon: LucideIcon; from: string; to: string; move: Record<string, number[]>; dur: number }> = {
  Find: { Icon: Search, from: '#6366f1', to: '#38bdf8', move: { x: [0, 3, 0, -3, 0], y: [0, -3, 0, 3, 0] }, dur: 3 },
  Confirm: { Icon: CheckCircle2, from: '#10b981', to: '#a3e635', move: { scale: [1, 1.25, 1] }, dur: 2.2 },
  Arrive: { Icon: QrCode, from: '#f59e0b', to: '#f43f5e', move: { y: [0, -4, 0], scale: [1, 0.94, 1] }, dur: 1.8 },
  Consult: { Icon: Stethoscope, from: '#0ea5e9', to: '#14b8a6', move: { rotate: [-12, 12, -12] }, dur: 3 },
  Pay: { Icon: CreditCard, from: '#8b5cf6', to: '#ec4899', move: { rotateY: [0, 180, 360] }, dur: 3.6 },
  Keep: { Icon: FolderHeart, from: '#ec4899', to: '#f59e0b', move: { scale: [1, 1.18, 1, 1.12, 1] }, dur: 2.4 },
};

function StepIcon({ step, index }: { step: string; index: number }) {
  const sc = SCENES[step];
  return (
    <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${sc.from}, ${sc.to})` }}>
      <motion.span
        aria-hidden
        className="absolute inset-0 rounded-2xl"
        style={{ background: `linear-gradient(135deg, ${sc.from}, ${sc.to})` }}
        animate={{ scale: [1, 1.5], opacity: [0.45, 0] }}
        transition={{ duration: 2.4, delay: index * 0.35, repeat: Infinity, ease: 'easeOut' }}
      />
      <motion.span className="relative" style={{ perspective: 200 }} animate={sc.move} transition={{ duration: sc.dur, delay: index * 0.2, repeat: Infinity, ease: 'easeInOut' }}>
        <sc.Icon size={22} />
      </motion.span>
    </span>
  );
}

// How a visit runs, from the product's real flow (see TESTING.md). A hairline
// table: uppercase headers, display-face first column, neutral metadata. On a
// narrow screen each row collapses to a two-column grid.
const ROWS = [
  { step: 'Find', who: 'Patient', what: 'Searches verified clinics and picks a doctor and a slot.', where: 'Patient app' },
  { step: 'Confirm', who: 'Clinic', what: 'The clinic confirms; the patient is notified at each step.', where: 'Clinic console' },
  { step: 'Arrive', who: 'Front desk', what: 'Check-in by QR or at the desk. The live token is issued in arrival order.', where: 'Queue board' },
  { step: 'Consult', who: 'Doctor', what: 'Notes and prescription are written once, then saved to the record.', where: 'Clinic console' },
  { step: 'Pay', who: 'Patient', what: 'Online or at the counter. Online payment never buys queue priority.', where: 'Payments' },
  { step: 'Keep', who: 'Patient', what: 'The visit, prescription and history stay in the patient\'s own account.', where: 'Records' },
];

export default function VisitTable() {
  return (
    <section id="for-clinics" className="relative isolate scroll-mt-14 overflow-hidden bg-ground-2 py-24" aria-labelledby="visit-heading">
      <span aria-hidden className="blob -z-10 -left-24 top-0 h-72 w-72 bg-indigo-300" />
      <span aria-hidden className="blob -z-10 -right-24 bottom-0 h-72 w-72 bg-emerald-300 [animation-delay:-6s]" />
      <span aria-hidden className="blob -z-10 left-1/2 top-1/3 h-56 w-56 bg-amber-200 [animation-delay:-10s]" />

      <div className="mx-auto max-w-6xl px-5">
        <Reveal><Label accent="primary">How a visit runs</Label></Reveal>
        <Reveal delay={0.08}>
          <h2 id="visit-heading" className="mt-5 font-display text-[clamp(28px,4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink">
            From search to record.
          </h2>
        </Reveal>

        <div className="mt-12" role="table" aria-label="How a visit runs">
          <div role="row" className="hidden grid-cols-[12rem_9rem_1fr_9rem] gap-6 border-b border-hairline px-2 pb-3 md:grid">
            {['Step', 'Who', 'What happens', 'Where'].map((h) => (
              <div key={h} role="columnheader"><Label>{h}</Label></div>
            ))}
          </div>
          {ROWS.map((r, i) => (
            <Reveal key={r.step} delay={i * 0.04} y={12}>
              <motion.div
                role="row"
                whileHover={{ x: 6 }}
                transition={{ type: 'spring', stiffness: 300, damping: 22 }}
                className="group grid grid-cols-2 gap-x-6 gap-y-2 rounded-2xl border-b border-hairline px-2 py-4 transition-colors hover:bg-white/70 md:grid-cols-[12rem_9rem_1fr_9rem] md:items-center"
              >
                <div role="cell" className="flex items-center gap-3 font-display text-2xl font-bold tracking-[-0.02em] text-ink">
                  <StepIcon step={r.step} index={i} />
                  <span
                    className="transition-colors [-webkit-background-clip:text] [background-clip:text] group-hover:text-transparent"
                    style={{ backgroundImage: `linear-gradient(100deg, ${SCENES[r.step].from}, ${SCENES[r.step].to})` }}
                  >
                    {r.step}
                  </span>
                </div>
                <div role="cell" className="self-center font-ui text-sm text-ink-2 md:self-auto">{r.who}</div>
                <div role="cell" className="col-span-2 font-ui text-sm leading-relaxed text-ink-2 md:col-span-1">{r.what}</div>
                <div role="cell" className="col-span-2 md:col-span-1">
                  <span
                    className="inline-block rounded-full px-3 py-1 font-ui text-[11px] font-medium uppercase tracking-[0.1em] text-white"
                    style={{ background: `linear-gradient(100deg, ${SCENES[r.step].from}, ${SCENES[r.step].to})` }}
                  >
                    {r.where}
                  </span>
                </div>
              </motion.div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
