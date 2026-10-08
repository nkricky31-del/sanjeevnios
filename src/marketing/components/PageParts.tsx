import { useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';

import { Label, Reveal } from './motionKit';

// Shared pieces for the inner marketing pages, in the same dark label style as
// the home page. Pages sit under the fixed 58px nav, hence the top padding.
export function PageHead({ eyebrow, accent = 'teal', title, lede, children }: {
  eyebrow: string; accent?: 'amber' | 'teal'; title: ReactNode; lede?: string; children?: ReactNode;
}) {
  return (
    <header className="mx-auto max-w-6xl px-5 pb-14 pt-[calc(58px+4.5rem)]">
      <Reveal><Label accent={accent}>{eyebrow}</Label></Reveal>
      <Reveal delay={0.08}>
        <h1 className="mt-5 max-w-[18ch] font-display text-[clamp(36px,6vw,84px)] font-extrabold leading-[0.98] tracking-[-0.035em] text-ink">
          {title}
        </h1>
      </Reveal>
      {lede && (
        <Reveal delay={0.16}>
          <p className="mt-6 max-w-xl font-ui text-base leading-relaxed text-ink-2">{lede}</p>
        </Reveal>
      )}
      {children && <Reveal delay={0.24} className="mt-8">{children}</Reveal>}
    </header>
  );
}

// Hairline-ruled rows: index, display title, body.
export function RuleList({ items, accent = 'teal' }: { items: { title: string; body: string }[]; accent?: 'amber' | 'teal' }) {
  return (
    <div className="mx-auto max-w-6xl px-5">
      <div className="border-t border-hairline">
        {items.map((it, i) => (
          <Reveal key={it.title} delay={i * 0.04} y={12}>
            <div className="grid gap-2 border-b border-hairline py-6 md:grid-cols-[4rem_minmax(0,18rem)_1fr] md:gap-8">
              <Label accent={accent} className="pt-1.5">{String(i + 1).padStart(2, '0')}</Label>
              <h2 className="font-display text-xl font-bold tracking-[-0.02em] text-ink sm:text-2xl">{it.title}</h2>
              <p className="max-w-xl font-ui text-sm leading-relaxed text-ink-2">{it.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}

export function Checklist({ title, items, accent = 'teal' }: { title: string; items: string[]; accent?: 'amber' | 'teal' }) {
  return (
    <section className="mt-20 bg-ground-2 py-20">
      <div className="mx-auto max-w-6xl px-5">
        <Reveal><h2 className="font-display text-[clamp(26px,3.6vw,44px)] font-extrabold tracking-[-0.03em] text-ink">{title}</h2></Reveal>
        <ul className="mt-8 max-w-2xl border-t border-hairline">
          {items.map((b, i) => (
            <Reveal key={b} delay={i * 0.04} y={10}>
              <li className="flex gap-4 border-b border-hairline py-4 font-ui text-sm leading-relaxed text-ink-2">
                <span aria-hidden className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${accent === 'amber' ? 'bg-amber' : 'bg-teal-text'}`} />
                {b}
              </li>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function PillButton({ to, children, tone = 'light' }: { to: string; children: ReactNode; tone?: 'light' | 'outline' }) {
  const navigate = useNavigate();
  const cls = tone === 'light'
    ? 'bg-ink text-ground hover:bg-white focus-visible:ring-amber'
    : 'border border-ink/40 text-ink hover:border-amber hover:text-amber focus-visible:ring-amber';
  return (
    <button type="button" onClick={() => navigate(to)}
      className={`cursor-pointer rounded-full px-7 py-3.5 font-ui text-sm font-semibold outline-none transition focus-visible:ring-2 ${cls}`}>
      {children}
    </button>
  );
}
