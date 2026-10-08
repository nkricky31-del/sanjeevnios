import { useEffect, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

// The landing page is one long page; its menu scrolls to sections instead of
// loading other pages. From any other route it goes home first, then scrolls.
export const SECTIONS = [
  { id: 'about', label: 'About' },
  { id: 'for-clinics', label: 'For clinics' },
  { id: 'for-patients', label: 'For patients' },
  { id: 'contact', label: 'Contact' },
] as const;

export function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function goToSection(id: string, pathname: string, navigate: NavigateFunction) {
  if (pathname === '/') scrollToSection(id);
  else navigate('/', { state: { scrollTo: id } });
}

// Which section is on screen now (for highlighting the menu).
export function useActiveSection(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const els = ids.map((i) => document.getElementById(i)).filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (vis) setActive(vis.target.id);
      },
      { rootMargin: '-35% 0px -45% 0px', threshold: [0, 0.2, 0.5] }
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [ids]);
  return active;
}
