import { Lock } from 'lucide-react';
import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import { useState } from 'react';

// A read-only value (like a legal name) that is visibly, playfully locked. The
// padlock sways gently while idle and rattles when you hover it; try to touch
// the field and the whole row shakes and a small note says why it won't change.
export default function LockedField({ value, placeholder = 'Not set', note = 'Locked - request a change instead' }: { value: string; placeholder?: string; note?: string }) {
  const controls = useAnimationControls();
  const [tip, setTip] = useState(false);

  const rattle = () => {
    void controls.start({ x: [0, -7, 7, -5, 5, -2, 0], transition: { duration: 0.45 } });
    setTip(true);
    window.setTimeout(() => setTip(false), 2200);
  };

  return (
    <motion.div animate={controls} className="relative mt-1.5 flex items-center gap-2" onClick={rattle}>
      <motion.span
        className="inline-flex h-9 w-9 shrink-0 cursor-not-allowed items-center justify-center rounded-xl bg-slate-100 text-slate-600"
        animate={{ rotate: [0, -8, 6, -4, 0] }}
        transition={{ duration: 1.4, repeat: Infinity, repeatDelay: 4.5, ease: 'easeInOut' }}
        whileHover={{ rotate: [0, -18, 16, -12, 10, 0], scale: 1.12, transition: { duration: 0.55 } }}
      >
        <Lock size={16} />
      </motion.span>

      <div className="relative min-w-0 flex-1 overflow-hidden rounded-2xl">
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          disabled
          readOnly
          aria-label="Locked"
          className="w-full cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-100 px-3 py-2.5 text-sm text-slate-600 outline-none"
        />
        {/* a disabled input swallows clicks, so this catches them for the shake */}
        <span aria-hidden className="absolute inset-0 cursor-not-allowed" />
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/4 -skew-x-[20deg] bg-gradient-to-r from-transparent via-white/60 to-transparent"
          animate={{ left: ['-30%', '130%'] }}
          transition={{ duration: 2.2, repeat: Infinity, repeatDelay: 5, ease: 'easeInOut' }}
        />
      </div>

      <AnimatePresence>
        {tip && (
          <motion.span
            role="status"
            className="absolute -top-8 right-0 rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-medium text-white shadow-lg"
            initial={{ opacity: 0, y: 6, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4 }}
          >
            {note}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
