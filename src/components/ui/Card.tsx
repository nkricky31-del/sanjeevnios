import { animate, useReducedMotion } from 'motion/react';
import { useEffect, useRef, type PropsWithChildren } from 'react';

import { EASE_OUT } from '../../lib/motionKit';

// The surface everything is built on: a hairline border on the card ground, no
// shadow. On entering it rises into place; cards lower on the screen start a
// moment later, so a page of cards cascades in instead of appearing at once.
// Anything inside the card that already does something on click keeps doing it.
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="switch"], [role="button"]';

export default function Card({
  children, className = '', onOpen, accent,
}: PropsWithChildren<{ className?: string; /** Makes the whole card a link to its detail page. */ onOpen?: () => void; /** The colour its hover glow takes. */ accent?: string }>) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;
    const delay = Math.min(0.3, Math.max(0, el.getBoundingClientRect().top / 2200));
    const controls = animate(el, { opacity: [0, 1], y: [14, 0] }, { duration: 0.5, delay, ease: EASE_OUT });
    // Safety net: never leave a card hidden if the animation is interrupted.
    const settle = window.setTimeout(() => {
      el.style.opacity = '1';
      el.style.transform = '';
    }, (delay + 0.5) * 1000 + 700);
    return () => {
      controls.stop();
      window.clearTimeout(settle);
      el.style.opacity = '1';
      el.style.transform = '';
    };
  }, [reduce]);

  return (
    <div
      ref={ref}
      data-open={onOpen ? 'true' : undefined}
      role={onOpen ? 'link' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? (e) => { if (!(e.target as HTMLElement).closest(INTERACTIVE)) onOpen(); } : undefined}
      onKeyDown={onOpen ? (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } } : undefined}
      style={{ ...(reduce ? {} : { opacity: 0 }), ...(accent ? ({ '--accent': accent } as React.CSSProperties) : {}) }}
      className={`${onOpen ? 'group/open relative cursor-pointer ' : ''}rounded-2xl border border-slate-100 bg-white p-4 ${/hover:/.test(className) ? 'transition duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-slate-900/5' : ''} ${className}`}
    >
      {children}
      {onOpen && <span aria-hidden className="open-hint">Open</span>}
    </div>
  );
}
