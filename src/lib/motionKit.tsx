import { animate, motion, useInView, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { useCallback, useEffect, useRef } from 'react';

export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

// Gently slides each child of a list into place, one after another, and does
// the same for any child added later (data arriving, filters changing). Attach
// the returned ref to the list container:
//     const list = useStaggerIn();   ...   <div ref={list} className="grid ...">
// Nothing in the list needs to change, and with prefers-reduced-motion set it
// does nothing at all.
export function useStaggerIn(step = 0.055) {
  const reduce = useReducedMotion();
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el || reduce) return;
      const reveal = (nodes: Element[]) => {
        nodes.slice(0, 14).forEach((node, i) => {
          const target = node as HTMLElement;
          target.style.opacity = '0';
          const delay = i * step;
          animate(target, { opacity: 1, y: [16, 0] }, { duration: 0.5, delay, ease: EASE_OUT });
          // Safety net: if the list reorders mid-animation the browser can cancel
          // it. Whatever happens, the item is fully visible a moment after it
          // should have finished.
          window.setTimeout(() => {
            target.style.opacity = '1';
            target.style.transform = '';
          }, (delay + 0.5) * 1000 + 700);
        });
        // anything past the first screenful just appears
        nodes.slice(14).forEach((node) => ((node as HTMLElement).style.opacity = '1'));
      };
      reveal([...el.children]);
      const observer = new MutationObserver((mutations) => {
        const added = mutations.flatMap((m) => [...m.addedNodes]).filter((n): n is Element => n.nodeType === 1);
        if (added.length) reveal(added);
      });
      observer.observe(el, { childList: true });
      return () => observer.disconnect();
    },
    [reduce, step]
  );
}

// A number that counts up from zero the first time it scrolls into view.
export function CountUp({ value, className }: { value: number; className?: string }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' });
  const mv = useMotionValue(reduce ? value : 0);
  const text = useTransform(mv, (v) => Math.round(v).toLocaleString('en-IN'));

  useEffect(() => {
    if (reduce) {
      mv.set(value);
      return;
    }
    if (!inView) return;
    const controls = animate(mv, value, { duration: 1.2, ease: 'easeOut' });
    return () => controls.stop();
  }, [inView, value, reduce, mv]);

  return (
    <motion.span ref={ref} className={className}>
      {text}
    </motion.span>
  );
}
