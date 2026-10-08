import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Opening a page (a link or button) slides it in from the right; going back
// slides it in from the left - so the screens feel like a stack you move along.
// With prefers-reduced-motion set, MotionConfig (main.tsx) drops the movement.
export default function PageTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const type = useNavigationType();
  const from = type === 'POP' ? -44 : type === 'REPLACE' ? 0 : 44;
  return (
    <motion.div
      key={pathname}
      initial={{ opacity: 0, x: from, y: from === 0 ? 18 : 6, scale: 0.99 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 220, damping: 26, mass: 0.9 }}
    >
      {children}
    </motion.div>
  );
}
