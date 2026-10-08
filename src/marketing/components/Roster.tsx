import { Building2, MapPin, Radio, Stethoscope, Users, type LucideIcon } from 'lucide-react';
import { animate, motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { fetchPublicStats, type PublicStats } from '../../lib/publicStats';
import { Label, Reveal } from './motionKit';
import BrandName from '../../components/ui/BrandName';

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

const TONES: Record<string, { Icon: LucideIcon; from: string; to: string; motion: Record<string, number[]> }> = {
  clinics_onboarded: { Icon: Building2, from: '#6366f1', to: '#38bdf8', motion: { y: [0, -3, 0] } },
  clinics_live: { Icon: Radio, from: '#10b981', to: '#a3e635', motion: { scale: [1, 1.2, 1] } },
  doctors_onboarded: { Icon: Stethoscope, from: '#f59e0b', to: '#f43f5e', motion: { rotate: [0, -10, 10, 0] } },
  patients_served: { Icon: Users, from: '#ec4899', to: '#8b5cf6', motion: { scale: [1, 1.12, 1] } },
  cities_covered: { Icon: MapPin, from: '#0ea5e9', to: '#14b8a6', motion: { y: [0, -4, 0] } },
};

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
    <section className="relative isolate overflow-hidden bg-ground py-24" aria-labelledby="roster-heading">
      <span aria-hidden className="blob -z-10 -left-24 top-0 h-72 w-72 bg-indigo-300" />
      <span aria-hidden className="blob -z-10 -right-24 bottom-0 h-72 w-72 bg-emerald-300 [animation-delay:-6s]" />
      <span aria-hidden className="blob -z-10 left-1/2 top-1/3 h-56 w-56 bg-amber-200 [animation-delay:-10s]" />

      <div className="mx-auto max-w-6xl px-5">
        <Reveal><Label accent="leaf">The network, live</Label></Reveal>
        <Reveal delay={0.08}>
          <h2 id="roster-heading" className="mt-5 max-w-xl font-display text-[clamp(28px,4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink">
            Who is on <BrandName /> today.
          </h2>
        </Reveal>
        <div className={`mt-12 grid gap-4 sm:grid-cols-2 ${rows.length === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
          {rows.map((r, i) => {
            const t = TONES[r.key];
            const value = stats ? (stats[r.key] as number) : 0;
            return (
              <Reveal key={r.key} delay={i * 0.07} y={22}>
                <motion.div
                  whileHover={{ y: -6, scale: 1.02 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 18 }}
                  className="group relative h-full overflow-hidden rounded-3xl border border-hairline bg-white/80 p-6 shadow-sm backdrop-blur"
                >
                  {/* a wash of the tile's colour that swells on hover */}
                  <span
                    aria-hidden
                    className="absolute -right-10 -top-10 h-40 w-40 rounded-full opacity-25 blur-2xl transition-all duration-500 group-hover:scale-150 group-hover:opacity-45"
                    style={{ background: `linear-gradient(135deg, ${t.from}, ${t.to})` }}
                  />
                  <div className="relative flex items-start justify-between">
                    <span className="relative flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${t.from}, ${t.to})` }}>
                      <motion.span
                        aria-hidden
                        className="absolute inset-0 rounded-2xl"
                        style={{ background: `linear-gradient(135deg, ${t.from}, ${t.to})` }}
                        animate={{ scale: [1, 1.55], opacity: [0.45, 0] }}
                        transition={{ duration: 2.4, delay: i * 0.4, repeat: Infinity, ease: 'easeOut' }}
                      />
                      <motion.span className="relative" animate={t.motion} transition={{ duration: 3.4, delay: i * 0.3, repeat: Infinity, ease: 'easeInOut' }}>
                        <t.Icon size={22} />
                      </motion.span>
                    </span>
                    <Label accent={r.tag === 'Network' ? 'primary' : 'leaf'}>{r.tag}</Label>
                  </div>
                  <p
                    className="relative mt-6 font-display text-5xl font-extrabold tabular-nums tracking-[-0.03em] text-transparent bg-clip-text"
                    style={{ backgroundImage: `linear-gradient(120deg, ${t.from}, ${t.to})` }}
                  >
                    {stats ? <Count value={value} /> : '-'}
                  </p>
                  <p className="relative mt-1 font-display text-lg font-bold tracking-[-0.01em] text-ink">{r.name}</p>
                  {/* a bar that fills as the tile scrolls in */}
                  <span className="relative mt-5 block h-1.5 overflow-hidden rounded-full bg-ink/10">
                    <motion.span
                      className="block h-full rounded-full"
                      style={{ background: `linear-gradient(90deg, ${t.from}, ${t.to})` }}
                      initial={{ width: 0 }}
                      whileInView={{ width: `${Math.min(100, 28 + value * 6)}%` }}
                      viewport={{ once: true }}
                      transition={{ duration: 1.3, delay: 0.2 + i * 0.08, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </span>
                </motion.div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
