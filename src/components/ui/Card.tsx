import { animate, useReducedMotion } from 'motion/react';
import { useEffect, useRef, type PropsWithChildren } from 'react';

import { EASE_OUT } from '../../lib/motionKit';

// The surface everything is built on: a hairline border on the card ground, no
// shadow. On entering it rises into place; cards lower on the screen start a
// moment later, so a page of cards cascades in instead of appearing at once.
export default function Card({ children, className = '' }: PropsWithChildren<{ className?: string }>) {
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
      style={reduce ? undefined : { opacity: 0 }}
      className={`rounded-2xl border border-slate-100 bg-white p-4 ${/hover:/.test(className) ? 'transition duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-slate-900/5' : ''} ${className}`}
    >
      {children}
    </div>
  );
}
