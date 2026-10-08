import { motion } from 'motion/react';

interface Props {
  size?: number;
  className?: string;
  /** 'brand' = heart in the accent colour with a white cross (default);
      'light' = a white heart with an accent cross, for dark backgrounds. */
  tone?: 'brand' | 'light';
  /** Heartbeat + a ring that pulses outward. Turn off for tiny / repeated uses. */
  animated?: boolean;
}

const HEART =
  'M32 57S6 41.6 6 24.2C6 14.7 13.4 8 22 8c5.2 0 9.1 2.5 10 5.6C32.9 10.5 36.8 8 42 8c8.6 0 16 6.7 16 16.2C58 41.6 32 57 32 57Z';
const CROSS = 'M28.4 17.6h7.2v7.2h7.2v7.2h-7.2v7.2h-7.2v-7.2h-7.2v-7.2h7.2v-7.2Z';

// The SanjeevniOS mark: a heart (in the screen's accent colour, indigo by
// default) with a medical cross punched out of it. It beats - a quick "lub-dub"
// followed by a rest, like a pulse - and a soft ring ripples out behind it. On
// hover it jumps. Inline SVG so it scales cleanly and picks up the accent.
export default function BrandMark({ size = 64, className = '', tone = 'brand', animated = true }: Props) {
  const light = tone === 'light';
  const heartFill = light ? '#ffffff' : 'url(#sanjeevni-heart)';
  const crossFill = light ? 'var(--accent, #3b5bdb)' : '#ffffff';

  return (
    <motion.span
      className={`relative inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      whileHover={animated ? { scale: 1.12, rotate: -6 } : undefined}
      whileTap={animated ? { scale: 0.92 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 14 }}
    >
      {animated && (
        <motion.span
          aria-hidden
          className="absolute inset-[12%] rounded-full"
          style={{ background: light ? 'rgba(255,255,255,0.55)' : 'var(--accent, #3b5bdb)' }}
          animate={{ scale: [0.9, 1.9], opacity: [0.35, 0] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
      <motion.svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        className="relative"
        aria-label="SanjeevniOS"
        animate={animated ? { scale: [1, 1.14, 1, 1.09, 1, 1] } : undefined}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut', times: [0, 0.1, 0.22, 0.32, 0.46, 1] }}
      >
        <defs>
          <linearGradient id="sanjeevni-heart" x1="12" y1="6" x2="52" y2="58" gradientUnits="userSpaceOnUse">
            <stop style={{ stopColor: 'var(--accent, #3b5bdb)' }} />
            <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--accent, #3b5bdb) 78%, #111827)' }} />
          </linearGradient>
        </defs>
        <path d={HEART} fill={heartFill} />
        <motion.path
          d={CROSS}
          fill={crossFill}
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          animate={animated ? { scale: [1, 1.12, 1] } : undefined}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut', times: [0, 0.1, 0.46] }}
        />
      </motion.svg>
    </motion.span>
  );
}
