import { Label, Reveal } from './motionKit';

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
    <section className="relative isolate overflow-hidden bg-ground-2 py-24" aria-labelledby="visit-heading">
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
          <div role="row" className="hidden grid-cols-[8rem_9rem_1fr_9rem] gap-6 border-b border-hairline pb-3 md:grid">
            {['Step', 'Who', 'What happens', 'Where'].map((h) => (
              <div key={h} role="columnheader"><Label>{h}</Label></div>
            ))}
          </div>
          {ROWS.map((r, i) => (
            <Reveal key={r.step} delay={i * 0.04} y={12}>
              <div role="row" className="grid grid-cols-2 gap-x-6 gap-y-2 border-b border-hairline py-5 md:grid-cols-[8rem_9rem_1fr_9rem] md:items-baseline">
                <div role="cell" className="font-display text-2xl font-bold tracking-[-0.02em] text-ink">{r.step}</div>
                <div role="cell" className="self-center font-ui text-sm text-ink-2 md:self-auto">{r.who}</div>
                <div role="cell" className="col-span-2 font-ui text-sm leading-relaxed text-ink-2 md:col-span-1">{r.what}</div>
                <div role="cell" className="col-span-2 font-ui text-xs uppercase tracking-[0.1em] text-muted md:col-span-1">{r.where}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
