import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

// A short fade-and-rise whenever the route changes. Keyed on the path so each
// screen enters fresh; with prefers-reduced-motion set, MotionConfig (main.tsx)
// skips the rise and the page simply appears.
export default function PageTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <motion.div
      key={pathname}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
