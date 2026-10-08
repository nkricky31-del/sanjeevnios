import { motion } from 'motion/react';

// An on/off switch: the knob springs across and the track changes colour. Used
// wherever something is switched on or off (activate / deactivate).
export default function Toggle({
  checked, onChange, label, disabled = false, onLabel = 'Active', offLabel = 'Inactive',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        data-fx="own"
        className={`relative h-7 w-12 shrink-0 cursor-pointer rounded-full p-0.5 outline-none transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
          checked ? 'bg-gradient-to-r from-emerald-500 to-lime-400 shadow-[0_0_14px_-2px_rgba(16,185,129,0.8)]' : 'bg-slate-300'
        }`}
      >
        <motion.span
          className="block h-6 w-6 rounded-full bg-white shadow-md"
          animate={{ x: checked ? 20 : 0 }}
          whileTap={{ scaleX: 1.25 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />
      </button>
      <span className={`w-14 text-xs font-semibold transition-colors ${checked ? 'text-emerald-600' : 'text-slate-400'}`}>
        {checked ? onLabel : offLabel}
      </span>
    </span>
  );
}
