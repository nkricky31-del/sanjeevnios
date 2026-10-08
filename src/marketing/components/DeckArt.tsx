import { BadgeCheck, Building2, CheckCircle2, IndianRupee, MapPin, Pill, ShieldCheck, Stethoscope } from 'lucide-react';
import { motion } from 'motion/react';

// A small looping illustration for each card of the product deck.

const panel = 'relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl';

function Book() {
  const days = Array.from({ length: 21 }, (_, i) => i);
  return (
    <div className={`${panel} bg-gradient-to-br from-emerald-100 via-sky-100 to-indigo-100`}>
      <div className="grid grid-cols-7 gap-1.5">
        {days.map((d) => (
          <motion.span
            key={d}
            className="h-4 w-4 rounded-md bg-white/80 shadow-sm"
            animate={d === 10 ? { backgroundColor: ['#ffffff', '#10b981', '#10b981', '#ffffff'], scale: [1, 1.35, 1.35, 1] } : { opacity: [0.7, 1, 0.7] }}
            transition={d === 10 ? { duration: 3.2, repeat: Infinity, times: [0, 0.3, 0.8, 1] } : { duration: 2.5, delay: (d % 7) * 0.15, repeat: Infinity }}
          />
        ))}
      </div>
      <motion.span
        className="absolute right-6 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg"
        animate={{ y: [-30, 0, -4, 0], opacity: [0, 1, 1, 1] }}
        transition={{ duration: 3.2, repeat: Infinity, times: [0, 0.3, 0.45, 1] }}
      >
        <MapPin size={18} />
      </motion.span>
    </div>
  );
}

function Queue() {
  return (
    <div className={`${panel} bg-gradient-to-br from-indigo-100 via-violet-100 to-pink-100`}>
      <div className="flex w-full flex-col gap-2 px-6">
        {['A-15', 'A-16', 'A-17'].map((t, i) => (
          <motion.div
            key={t}
            className="flex items-center justify-between rounded-xl bg-white px-4 py-2 shadow-md"
            animate={{ x: [0, 0, 14, 0] }}
            transition={{ duration: 3, delay: i * 0.4, repeat: Infinity }}
          >
            <span className="font-display text-lg font-extrabold text-indigo-600">{t}</span>
            <span className="text-xs text-slate-400">{i === 2 ? 'You' : i === 0 ? 'Now serving' : 'Next'}</span>
          </motion.div>
        ))}
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/70">
          <motion.div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-pink-500" animate={{ width: ['10%', '85%'] }} transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }} />
        </div>
      </div>
    </div>
  );
}

function Consult() {
  return (
    <div className={`${panel} bg-gradient-to-br from-sky-100 via-teal-100 to-emerald-100`}>
      <motion.span className="absolute left-6 top-5 text-teal-600" animate={{ rotate: [-10, 10, -10] }} transition={{ duration: 3, repeat: Infinity }}>
        <Stethoscope size={30} />
      </motion.span>
      <div className="w-40 rounded-xl bg-white p-3 shadow-lg">
        {[100, 80, 90, 60].map((w, i) => (
          <motion.div key={i} className="mb-1.5 h-1.5 rounded-full bg-slate-200" animate={{ width: ['0%', `${w}%`, `${w}%`, '0%'] }} transition={{ duration: 4, delay: i * 0.25, repeat: Infinity, times: [0, 0.3, 0.85, 1] }} />
        ))}
        <svg viewBox="0 0 120 30" className="mt-1 w-full">
          <motion.path d="M0 15 L25 15 L33 3 L43 27 L52 15 L120 15" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: [0, 1, 1, 0] }} transition={{ duration: 3, repeat: Infinity, times: [0, 0.5, 0.85, 1] }} />
        </svg>
      </div>
      <motion.span className="absolute bottom-5 right-6 flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg" animate={{ y: [0, -8, 0], rotate: [0, 20, 0] }} transition={{ duration: 2.6, repeat: Infinity }}>
        <Pill size={17} />
      </motion.span>
    </div>
  );
}

function Pay() {
  return (
    <div className={`${panel} bg-gradient-to-br from-amber-100 via-orange-100 to-rose-100`}>
      <motion.div className="relative h-24 w-40 rounded-2xl bg-gradient-to-br from-indigo-600 to-fuchsia-600 p-3 text-white shadow-xl" animate={{ rotateY: [0, 180, 360] }} transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}>
        <div className="h-5 w-7 rounded bg-amber-300/90" />
        <div className="mt-4 flex gap-1.5">{[0, 1, 2, 3].map((i) => <span key={i} className="h-1.5 w-5 rounded-full bg-white/60" />)}</div>
      </motion.div>
      {[0, 1, 2].map((i) => (
        <motion.span key={i} className="absolute top-0 flex h-7 w-7 items-center justify-center rounded-full bg-amber-400 text-white shadow" style={{ left: `${28 + i * 22}%` }} animate={{ y: [-30, 120], opacity: [0, 1, 1, 0] }} transition={{ duration: 2.6, delay: i * 0.8, repeat: Infinity, ease: 'easeIn' }}>
          <IndianRupee size={14} />
        </motion.span>
      ))}
      <motion.span className="absolute bottom-4 right-5 text-emerald-600" animate={{ scale: [0, 1.2, 1, 1, 0] }} transition={{ duration: 5, repeat: Infinity, times: [0.5, 0.6, 0.65, 0.9, 1] }}>
        <CheckCircle2 size={28} />
      </motion.span>
    </div>
  );
}

function Verify() {
  return (
    <div className={`${panel} bg-gradient-to-br from-emerald-100 via-lime-100 to-sky-100`}>
      {[0, 1, 2].map((i) => (
        <motion.span key={i} className="absolute h-20 w-20 rounded-full border-2 border-emerald-400" animate={{ scale: [0.6, 2.4], opacity: [0.6, 0] }} transition={{ duration: 3, delay: i, repeat: Infinity, ease: 'easeOut' }} />
      ))}
      <motion.span className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-xl" animate={{ scale: [1, 1.08, 1], rotate: [0, -4, 4, 0] }} transition={{ duration: 3.5, repeat: Infinity }}>
        <ShieldCheck size={38} />
      </motion.span>
      <motion.span className="absolute left-7 top-6 flex h-9 w-9 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-lg" animate={{ y: [0, -6, 0] }} transition={{ duration: 3, repeat: Infinity }}><Building2 size={17} /></motion.span>
      <motion.span className="absolute bottom-6 right-7 flex h-9 w-9 items-center justify-center rounded-xl bg-white text-emerald-600 shadow-lg" animate={{ y: [0, 6, 0] }} transition={{ duration: 3.4, repeat: Infinity }}><BadgeCheck size={17} /></motion.span>
    </div>
  );
}

const ART = [Book, Queue, Consult, Pay, Verify];
export default function DeckArt({ index }: { index: number }) {
  const Art = ART[index % ART.length];
  return <div className="my-3 min-h-0 flex-1"><Art /></div>;
}
