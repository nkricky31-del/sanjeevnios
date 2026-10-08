import { AnimatePresence, motion } from 'motion/react';
import { useState, type ReactNode } from 'react';

// Wrap something that appears when a button is clicked: it unfolds (height +
// fade + a small rise) and folds away again when it goes. The clip that makes
// the unfolding possible is lifted afterwards, so focus rings and menus inside
// are never cut off.
export default function Present({ show, children }: { show: boolean; children: ReactNode }) {
  const [settled, setSettled] = useState(true);
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="panel"
          initial={{ height: 0, opacity: 0, y: -10 }}
          animate={{ height: 'auto', opacity: 1, y: 0 }}
          exit={{ height: 0, opacity: 0, y: -6 }}
          transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
          style={{ overflow: settled ? 'visible' : 'hidden' }}
          onAnimationStart={() => setSettled(false)}
          onAnimationComplete={() => setSettled(true)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
