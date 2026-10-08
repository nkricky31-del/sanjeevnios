import { animate, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { fetchPublicStats, type PublicStats } from '../../lib/publicStats';
import { Label, Reveal } from './motionKit';

// Refetch cadence on the client - close to get_public_stats()'s own 5-minute
// server-side cache window (schema.sql section 56), so a long-open tab stays
// live without adding load.
const REFRESH_MS = 3 * 60 * 1000;

const ROWS: { key: keyof PublicStats; tag: string; name: string }[] = [
  { key: 'clinics_onboarded', tag: 'Network', name: 'Clinics onboarded' },
  { key: 'clinics_live', tag: 'Network', name: 'Clinics live' },
  { key: 'doctors_onboarded', tag: 'People', name: 'Doctors onboarded' },
  { key: 'patients_served', tag: 'People', name: 'Patients served' },
  { key: 'cities_covered', tag: 'Reach', name: 'Cities covered' },
];

function format(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k+` : String(Math.round(n));
}

// Counts up once, when the row first scrolls into view.
function Count({ value }: { value: number }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' });
  const [shown, setShown] = useState(reduce ? value : 0);

  useEffect(() => {
    if (reduce) { setShown(value); return; }
    if (!inView) return;
    const controls = animate(0, value, { duration: 1.1, ease: 'easeOut', onUpdate: (v) => setShown(v) });
    return () => controls.stop();
  }, [inView, value, reduce]);

  return <span ref={ref}>{format(shown)}</span>;
}

// The live numbers, as hairline-ruled rows: a small uppercase accent label, a
// display-face name, a right-aligned count. These come straight from the
// database; if they can't be fetched the whole section quietly disappears
// rather than showing zeroes or an error.
export default function Roster() {
  const [stats, setStats] = useState<PublicStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const result = await fetchPublicStats();
      if (cancelled) return;
      if (result) { setStats(result); setFailed(false); } else setFailed(true);
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (failed) return null;
  // A zero reads as 'nothing here yet' on a public page, so only rows with a
  // real count are shown. They are still the true numbers, just not the zeroes.
  const rows = stats ? ROWS.filter((r) => (stats[r.key] as number) > 0) : ROWS;
  if (stats && rows.length === 0) return null;

  return (
    <section className="bg-ground py-24" aria-labelledby="roster-heading">
      <div className="mx-auto max-w-6xl px-5">
        <Reveal><Label accent="leaf">The network, live</Label></Reveal>
        <Reveal delay={0.08}>
          <h2 id="roster-heading" className="mt-5 max-w-xl font-display text-[clamp(28px,4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink">
            Who is on SanjeevniOS today.
          </h2>
        </Reveal>
        <div className="mt-12 border-t border-hairline">
          {rows.map((r, i) => (
            <Reveal key={r.key} delay={i * 0.05} y={14}>
              <div className="flex items-baseline gap-4 border-b border-hairline py-5 sm:gap-8 sm:py-6">
                <Label accent={r.tag === 'Network' ? 'primary' : 'leaf'} className="w-20 shrink-0 sm:w-28">{r.tag}</Label>
                <p className="flex-1 font-display text-xl font-bold tracking-[-0.02em] text-ink sm:text-3xl">{r.name}</p>
                <p className="font-display text-xl font-bold tabular-nums text-ink sm:text-3xl">
                  {stats ? <Count value={stats[r.key] as number} /> : '-'}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
