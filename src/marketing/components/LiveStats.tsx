import { useEffect, useState } from 'react';

import { fetchPublicStats, type PublicStats } from '../../lib/publicStats';

// Refetch cadence on the CLIENT - independent of, and deliberately close to,
// get_public_stats()'s own 5-minute server-side cache window (schema.sql
// section 56). Polling faster than that would just re-read the same cached
// row over and over; this keeps the strip feeling "live" across a long-open
// tab without adding any real load, since the server-side cache is what
// actually protects the DB.
const REFRESH_MS = 3 * 60 * 1000;

const TILES: { key: keyof PublicStats; label: string }[] = [
  { key: 'clinics_onboarded', label: 'Clinics onboarded' },
  { key: 'clinics_live', label: 'Clinics live' },
  { key: 'patients_served', label: 'Patients served' },
  { key: 'doctors_onboarded', label: 'Doctors onboarded' },
  { key: 'cities_covered', label: 'Cities covered' },
];

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k+`;
  return String(n);
}

export default function LiveStats() {
  const [stats, setStats] = useState<PublicStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const result = await fetchPublicStats();
      if (cancelled) return;
      if (result) {
        setStats(result);
        setFailed(false);
      } else {
        setFailed(true);
      }
    };

    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Quietly disappears rather than showing zeroes/an error to a visitor -
  // this strip is a nice-to-have, not load-bearing for the page.
  if (failed) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {TILES.map((t) => (
        <div key={t.key} className="rounded-2xl border border-white/15 bg-white/10 p-4 text-center backdrop-blur-sm">
          <p className="text-2xl font-extrabold text-white sm:text-3xl">
            {stats ? formatCount(stats[t.key] as number) : '—'}
          </p>
          <p className="mt-1 text-xs font-medium text-brand-100 sm:text-sm">{t.label}</p>
        </div>
      ))}
    </div>
  );
}
