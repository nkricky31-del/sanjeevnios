import { motion } from 'motion/react';

interface Props {
  className?: string;
  /** Colour of the closing full stop (class, or a literal colour via `dotColor`). */
  dotClassName?: string;
  dotColor?: string;
  /** Skip the entrance (e.g. for a logo that re-mounts often). */
  still?: boolean;
}

const NAME = 'SanjeevniOS';

// "SanjeevniOS." as letters: they spring up one after another when the logo
// first appears, ripple in a wave when you hover over it, and the full stop
// pulses like a heartbeat. Put it inside a link; it adds no behaviour of its own.
export default function Wordmark({ className = '', dotClassName = 'text-primary', dotColor, still = false }: Props) {
  return (
    <motion.span className={`inline-flex ${className}`} initial="rest" animate="in" whileHover="wave" aria-label="SanjeevniOS">
      {[...NAME].map((ch, i) => (
        <motion.span
          key={i}
          aria-hidden
          className="inline-block"
          variants={{
            rest: { y: still ? 0 : '0.6em', opacity: still ? 1 : 0 },
            in: { y: 0, opacity: 1, transition: { type: 'spring', stiffness: 260, damping: 15, delay: still ? 0 : 0.05 + i * 0.045 } },
            wave: { y: [0, -4, 0], transition: { duration: 0.5, delay: i * 0.03 } },
          }}
        >
          {ch}
        </motion.span>
      ))}
      <motion.span
        aria-hidden
        className={`inline-block ${dotClassName}`}
        style={dotColor ? { color: dotColor } : undefined}
        initial={{ opacity: 0, scale: 0 }}
        animate={{ opacity: 1, scale: [1, 1.7, 1, 1.4, 1] }}
        transition={{
          opacity: { delay: 0.65, duration: 0.3 },
          scale: { delay: 0.7, duration: 2.4, repeat: Infinity, ease: 'easeInOut', times: [0, 0.1, 0.22, 0.32, 0.46] },
        }}
      >
        .
      </motion.span>
    </motion.span>
  );
}
