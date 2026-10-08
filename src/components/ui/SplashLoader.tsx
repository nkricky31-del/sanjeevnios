import { motion } from 'motion/react';

import BrandMark from './BrandMark';

// The first thing you see while the app signs you in: the logo breathing inside
// two rings that ripple outward, with the name fading up underneath.
export default function SplashLoader({ label = 'SanjeevniOS' }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas" role="status" aria-label="Loading">
      <div className="relative flex h-28 w-28 items-center justify-center">
        {[0, 1].map((i) => (
          <motion.span
            key={i}
            aria-hidden
            className="absolute inset-0 rounded-full border-2 border-brand-400"
            initial={{ scale: 0.55, opacity: 0 }}
            animate={{ scale: [0.55, 1.5], opacity: [0.5, 0] }}
            transition={{ duration: 2.2, delay: i * 1.1, repeat: Infinity, ease: 'easeOut' }}
          />
        ))}
        <motion.div
          animate={{ scale: [1, 1.12, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        >
          <BrandMark size={56} />
        </motion.div>
      </div>
      <motion.p
        className="mt-5 font-display text-sm font-bold tracking-[-0.01em] text-slate-700"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: [0.4, 1, 0.4], y: 0 }}
        transition={{ opacity: { duration: 1.8, repeat: Infinity }, y: { duration: 0.5 } }}
      >
        {label}
      </motion.p>
    </div>
  );
}
