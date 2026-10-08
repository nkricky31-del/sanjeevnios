import { useEffect } from 'react';

// One listener for the whole app: pressing any enabled button (or role=button)
// drops a ring at the touch point. Buttons that draw their own ripple opt out
// with data-fx="own".
export function usePressFx() {
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('button, [role="button"]') as HTMLElement | null;
      if (!el || el.dataset.fx === 'own' || (el as HTMLButtonElement).disabled) return;
      if (!el.closest('.app-scope')) return;
      const ring = document.createElement('span');
      ring.className = 'press-ring';
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      // inherit the role accent
      const scope = el.closest('.app-scope') as HTMLElement;
      const accent = getComputedStyle(scope).getPropertyValue('--accent').trim();
      if (accent) ring.style.setProperty('--accent', accent);
      document.body.appendChild(ring);
      window.setTimeout(() => ring.remove(), 650);
    };
    document.addEventListener('pointerdown', onDown, { passive: true });
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);
}
