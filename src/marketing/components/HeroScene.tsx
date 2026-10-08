import { Activity, BadgeCheck, CalendarCheck, Clock, Pill, ShieldCheck, Stethoscope, Users } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion, useTransform, type MotionValue } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// The picture behind the wordmark once the panels open: an animated scene made
// of the product itself. A phone shows a live queue (the token ticks down), a
// heartbeat line draws itself, a verified doctor sits underneath; around it,
// glass cards float: appointment confirmed, prescription ready, live queue,
// doctor verified. All framer motion - nothing here is a photograph.
// ---------------------------------------------------------------------------

const STARS = Array.from({ length: 34 }, (_, i) => ({
  left: (i * 29 + 5) % 100,
  top: (i * 47 + 11) % 100,
  size: 1.5 + ((i * 3) % 3),
  delay: (i * 0.37) % 4,
  duration: 2.6 + ((i * 7) % 5) * 0.5,
}));

const TOKENS = [18, 17, 16, 15, 14, 13, 12];

// How big the phone is, and whether we are on a small screen (where it sits
// higher and smaller so the wordmark and the buttons stay readable below it).
function useStage() {
  const [state, setState] = useState({ scale: 1, small: false });
  useEffect(() => {
    const update = () => {
      const small = window.innerWidth < 640;
      const fit = Math.min((window.innerHeight * 0.62) / 520, (window.innerWidth * 0.72) / 260);
      setState({ small, scale: small ? Math.min(0.58, fit) : Math.max(0.5, Math.min(1, fit)) });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return state;
}

// The phone's screen: a live queue.
function PhoneScreen() {
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setI((n) => (n + 1) % TOKENS.length), 2400);
    return () => clearInterval(t);
  }, [reduce]);
  const token = TOKENS[i];
  const ahead = Math.max(0, token - 11);

  return (
    <div className="flex h-full flex-col bg-slate-50 text-slate-900">
      <div className="relative overflow-hidden px-5 pb-5 pt-9 text-white" style={{ background: 'linear-gradient(135deg,#2f4ab8,#3b5bdb 60%,#5c7cfa)' }}>
        <motion.span
          aria-hidden
          className="absolute -right-8 -top-8 h-28 w-28 rounded-full bg-white/20 blur-2xl"
          animate={{ scale: [1, 1.3, 1], opacity: [0.5, 0.9, 0.5] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
        />
        <p className="relative text-[10px] font-semibold uppercase tracking-[0.18em] text-white/75">Your token</p>
        <div className="relative mt-1 flex h-16 items-end overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p
              key={token}
              className="font-display text-6xl font-extrabold leading-none tracking-[-0.04em]"
              initial={{ y: 48, opacity: 0, rotateX: -60 }}
              animate={{ y: 0, opacity: 1, rotateX: 0 }}
              exit={{ y: -48, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 22 }}
            >
              A-{token}
            </motion.p>
          </AnimatePresence>
        </div>
        <p className="relative mt-2 flex items-center gap-1.5 text-[11px] text-white/85">
          <Clock size={12} /> {ahead === 0 ? "You're next" : `${ahead} ahead · about ${ahead * 4} min`}
        </p>
      </div>

      <div className="flex-1 space-y-3 px-4 pt-4">
        <div>
          <div className="flex justify-between text-[10px] font-semibold text-slate-500">
            <span>Queue progress</span>
            <span>Now serving A-11</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-200">
            <motion.div
              className="h-full rounded-full"
              style={{ background: 'linear-gradient(90deg,#3b5bdb,#10b981)' }}
              animate={{ width: `${100 - (ahead / 7) * 100 + 8}%` }}
              transition={{ type: 'spring', stiffness: 80, damping: 18 }}
            />
          </div>
        </div>

        {/* heartbeat that draws itself */}
        <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500">
            <Activity size={12} className="text-emerald-500" /> Live
          </div>
          <svg viewBox="0 0 220 44" className="mt-1 h-10 w-full" fill="none">
            <motion.path
              d="M0 24 H46 L56 24 L64 6 L74 40 L84 14 L92 24 H130 L140 24 L148 10 L158 36 L166 24 H220"
              stroke="#10b981"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0, opacity: 0.2 }}
              animate={{ pathLength: [0, 1, 1], opacity: [1, 1, 0.1] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut', times: [0, 0.7, 1] }}
            />
          </svg>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full text-white" style={{ background: 'linear-gradient(135deg,#3b5bdb,#10b981)' }}>
            <Stethoscope size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold">Dr. Agarwal</p>
            <p className="text-[10px] text-slate-500">General Physician</p>
          </div>
          <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-bold text-emerald-700">
            <BadgeCheck size={10} /> Verified
          </span>
        </div>

        <motion.div
          className="rounded-xl py-2.5 text-center text-xs font-bold text-white"
          style={{ background: 'linear-gradient(135deg,#3b5bdb,#5c7cfa)' }}
          animate={{ scale: [1, 1.03, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        >
          I've arrived
        </motion.div>
      </div>
    </div>
  );
}

function FloatCard({
  className, delay = 0, depth = 1, p, children,
}: { className: string; delay?: number; depth?: number; p: MotionValue<number>; children: ReactNode }) {
  const y = useTransform(p, [0, 1], [0, -34 * depth]);
  return (
    <motion.div className={`absolute ${className}`} style={{ y }}>
      <motion.div
        className="flex items-center gap-3 rounded-2xl border border-white/30 bg-white/12 px-4 py-3 text-white shadow-2xl shadow-black/25 backdrop-blur-xl"
        initial={{ opacity: 0, scale: 0.7, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: [0, -12, 0] }}
        transition={{
          opacity: { duration: 0.6, delay: 0.5 + delay },
          scale: { type: 'spring', stiffness: 200, damping: 16, delay: 0.5 + delay },
          y: { duration: 5 + delay * 2, delay: 0.6 + delay, repeat: Infinity, ease: 'easeInOut' },
        }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

const ICON = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl';

export default function HeroScene({ p, scale }: { p: MotionValue<number>; scale: MotionValue<number> }) {
  const { scale: s, small } = useStage();
  const phoneY = useTransform(p, [0, 1], [0, 30]);

  return (
    <motion.div
      aria-hidden
      className="absolute inset-0 -z-50 overflow-hidden"
      style={{ scale, background: 'linear-gradient(140deg,#070d2e 0%,#12206b 42%,#1f3fb8 72%,#0b6e5a 100%)' }}
    >
      {/* aurora */}
      <motion.div
        className="absolute -left-40 top-0 h-[44rem] w-[44rem] rounded-full blur-3xl"
        style={{ background: 'rgba(92,124,250,0.55)' }}
        animate={{ x: [0, 140, 0], y: [0, 80, 0], scale: [1, 1.2, 1] }}
        transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -bottom-48 -right-32 h-[40rem] w-[40rem] rounded-full blur-3xl"
        style={{ background: 'rgba(16,185,129,0.45)' }}
        animate={{ x: [0, -120, 0], y: [0, -70, 0], scale: [1.1, 0.95, 1.1] }}
        transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="absolute inset-0 opacity-50 [background-image:radial-gradient(rgba(255,255,255,0.22)_1px,transparent_1px)] [background-size:36px_36px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
      {STARS.map((st, i) => (
        <motion.span
          key={i}
          className="absolute rounded-full bg-white"
          style={{ left: `${st.left}%`, top: `${st.top}%`, width: st.size, height: st.size }}
          animate={{ opacity: [0.1, 0.9, 0.1], scale: [0.8, 1.4, 0.8] }}
          transition={{ duration: st.duration, delay: st.delay, repeat: Infinity, ease: 'easeInOut' }}
        />
      ))}

      {/* sonar rings around the phone */}
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="absolute left-1/2 top-1/2 h-[26rem] w-[26rem] -ml-[13rem] -mt-[13rem] rounded-full border-2 border-white/30"
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: [0.4, 2.2], opacity: [0.5, 0] }}
          transition={{ duration: 7, delay: i * 2.3, repeat: Infinity, ease: 'easeOut' }}
        />
      ))}

      {/* the phone */}
      <motion.div
        className="absolute left-1/2"
        style={{ y: phoneY, x: '-50%', top: small ? '15%' : '50%', marginTop: small ? 0 : -260 * s }}
      >
        <motion.div
          className="origin-top"
          style={{ scale: s }}
          initial={{ opacity: 0, y: 70, rotate: -5 }}
          animate={{ opacity: 1, y: [0, -10, 0], rotate: [0, 0.8, 0] }}
          transition={{
            opacity: { duration: 0.8, delay: 0.2 },
            y: { duration: 6, delay: 1, repeat: Infinity, ease: 'easeInOut' },
            rotate: { duration: 9, repeat: Infinity, ease: 'easeInOut' },
          }}
        >
          <div className="relative h-[520px] w-[260px] overflow-hidden rounded-[2.4rem] border-[7px] border-slate-900 bg-slate-900 shadow-[0_40px_90px_-20px_rgba(0,0,0,0.65)]">
            <span className="absolute left-1/2 top-2 z-10 h-4 w-20 -translate-x-1/2 rounded-full bg-slate-900" />
            <PhoneScreen />
          </div>
        </motion.div>
      </motion.div>

      {/* floating glass cards */}
      <FloatCard p={p} depth={0.8} delay={0} className="left-[5%] top-[21%] hidden sm:block">
        <span className={`${ICON} bg-emerald-400/90 text-white`}><CalendarCheck size={20} /></span>
        <span>
          <span className="block text-sm font-bold">Appointment confirmed</span>
          <span className="block text-xs text-white/75">Today · 11:40 AM</span>
        </span>
      </FloatCard>
      <FloatCard p={p} depth={0.6} delay={0.5} className="right-[5%] top-[19%] hidden sm:block">
        <span className={`${ICON} bg-indigo-300/90 text-indigo-950`}><Pill size={20} /></span>
        <span>
          <span className="block text-sm font-bold">Prescription ready</span>
          <span className="block text-xs text-white/75">Saved to your records</span>
        </span>
      </FloatCard>
      <FloatCard p={p} depth={0.5} delay={1} className="bottom-[19%] right-[4%] hidden md:block">
        <span className={`${ICON} bg-sky-300/90 text-sky-950`}><ShieldCheck size={20} /></span>
        <span>
          <span className="block text-sm font-bold">Doctor verified</span>
          <span className="block text-xs text-white/75">Documents reviewed</span>
        </span>
      </FloatCard>
      <FloatCard p={p} depth={0.4} delay={1.5} className="left-[3%] top-[68%] hidden xl:block">
        <span className={`${ICON} bg-amber-300/90 text-amber-950`}><Users size={20} /></span>
        <span>
          <span className="block text-sm font-bold">Live queue</span>
          <span className="block text-xs text-white/75">3 ahead of you</span>
        </span>
      </FloatCard>
    </motion.div>
  );
}
