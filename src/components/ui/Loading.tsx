import { motion } from 'motion/react';

import BrandMark from './BrandMark';

const SIZES = { sm: 26, md: 40, lg: 60 } as const;

// What any screen or section shows while it loads: the SanjeevniOS heart
// beating inside two rippling rings - the sign-in splash, sized for the spot.
// It fades in only after a moment (.sn-loading in index.css), so anything that
// loads quickly never flashes it at all.
export default function Loading({
  className = '',
  size = 'md',
  label = 'Loading',
}: {
  className?: string;
  size?: keyof typeof SIZES;
  label?: string;
}) {
  const mark = SIZES[size];
  const box = Math.round(mark * 1.9);
  return (
    <span role="status" className={`sn-loading flex w-full flex-col items-center justify-center py-6 ${className}`}>
      <span className="relative flex items-center justify-center" style={{ width: box, height: box }} aria-hidden>
        {[0, 1].map((i) => (
          <motion.span
            key={i}
            className="absolute inset-0 rounded-full border-2 border-brand-400"
            initial={{ scale: 0.55, opacity: 0 }}
            animate={{ scale: [0.55, 1.3], opacity: [0.55, 0] }}
            transition={{ duration: 1.6, delay: i * 0.8, repeat: Infinity, ease: 'easeOut' }}
          />
        ))}
        <motion.span
          className="flex"
          animate={{ scale: [1, 1.14, 1, 1.08, 1] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut', times: [0, 0.15, 0.3, 0.45, 1] }}
        >
          <BrandMark size={mark} animated={false} />
        </motion.span>
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
