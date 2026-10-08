import { motion } from 'motion/react';
import { useLayoutEffect, type ReactNode } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// The five bottom-bar tabs.
const TAB_ROOTS = ['/', '/bookings', '/records', '/payments', '/profile'];

// Switching tabs is a quick fade with a tiny rise (no sideways travel, no spring
// overshoot - those made the page shake on a phone). Opening a detail page slides
// in a short distance from the right, going back from the left. Every change
// starts at the top, and the page keeps a minimum height so it does not collapse
// and jump while its data loads.
export default function PageTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const type = useNavigationType();
  const isTab = TAB_ROOTS.includes(pathname);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  const from = isTab || type === 'REPLACE' ? 0 : type === 'POP' ? -18 : 18;
  return (
    <motion.div
      key={pathname}
      className="min-h-[70vh] [contain:layout_paint]"
      initial={{ opacity: 0, x: from, y: isTab ? 8 : 0 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: isTab ? 0.2 : 0.26, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
