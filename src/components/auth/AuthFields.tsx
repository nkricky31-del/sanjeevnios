import { AlertCircle, ArrowRight, Info, type LucideIcon } from 'lucide-react';
import { animate, motion, useMotionTemplate, useMotionValue } from 'motion/react';
import { useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';

import { livePhoneDigits } from '../../lib/phone';

// Building blocks for the three sign-in screens. They read the screen's accent
// from the --accent CSS variable AuthShell sets, so one set of components
// serves patient (teal), clinic (amber) and admin (violet).

// The input's border follows the pointer (a soft accent glow that only exists
// inside a 2px frame) and goes fully accent while the field has focus.
function GlowField({ children }: { children: ReactNode }) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const radius = useMotionValue(0);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    const controls = animate(radius, focus ? 420 : hover ? 110 : 0, { duration: 0.25 });
    return () => controls.stop();
  }, [focus, hover, radius]);

  const background = useMotionTemplate`radial-gradient(${radius}px circle at ${x}px ${y}px, var(--accent), transparent 80%)`;

  return (
    <motion.div
      style={{ background }}
      onMouseMove={({ currentTarget, clientX, clientY }) => {
        const { left, top } = currentTarget.getBoundingClientRect();
        x.set(clientX - left);
        y.set(clientY - top);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      className="rounded-xl p-[2px]"
    >
      {children}
    </motion.div>
  );
}

export function AuthLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-[10.5px] font-medium uppercase tracking-[0.12em] text-ink-2">
      {children}
    </label>
  );
}

const INPUT_BASE =
  'w-full bg-transparent px-3 py-3 text-sm text-ink outline-none placeholder:text-muted disabled:opacity-50';

export function PhoneField({
  label, value, onChange, placeholder,
}: { label: string; value: string; onChange: (digits: string) => void; placeholder: string }) {
  const id = useId();
  return (
    <div>
      <AuthLabel htmlFor={id}>{label}</AuthLabel>
      <div className="mt-2">
        <GlowField>
          <div className="flex items-center rounded-[10px] border border-hairline bg-ground">
            <span className="flex items-center gap-2 border-r border-hairline px-3 py-3 text-sm font-medium text-ink">
              {/* drawn flag: the emoji falls back to the letters "IN" on Windows */}
              <span aria-hidden className="flex h-3.5 w-5 flex-col overflow-hidden rounded-sm ring-1 ring-hairline">
                <span className="flex-1 bg-[#FF9933]" />
                <span className="flex flex-1 items-center justify-center bg-white">
                  <span className="h-1 w-1 rounded-full ring-[0.5px] ring-[#128807]" />
                </span>
                <span className="flex-1 bg-[#128807]" />
              </span>
              +91
            </span>
            <input
              id={id}
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              maxLength={15}
              value={value}
              onChange={(e) => onChange(livePhoneDigits(e.target.value))}
              placeholder={placeholder}
              className={INPUT_BASE}
            />
          </div>
        </GlowField>
      </div>
    </div>
  );
}

export function TextField({
  label, value, onChange, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  const id = useId();
  return (
    <div>
      <AuthLabel htmlFor={id}>{label}</AuthLabel>
      <div className="mt-2">
        <GlowField>
          <input
            id={id}
            type="text"
            autoComplete="off"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className={`${INPUT_BASE} rounded-[10px] border border-hairline bg-ground`}
          />
        </GlowField>
      </div>
    </div>
  );
}

export function OtpField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div>
      <AuthLabel htmlFor={id}>6-digit code</AuthLabel>
      <div className="mt-2">
        <GlowField>
          <input
            id={id}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={value}
            onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
            placeholder="······"
            className="w-full rounded-[10px] border border-hairline bg-ground px-3 py-3.5 text-center font-display text-2xl font-bold tracking-[0.45em] text-ink outline-none placeholder:text-muted"
          />
        </GlowField>
      </div>
    </div>
  );
}

export function AuthHeading({ title, sub }: { title: string; sub: ReactNode }) {
  return (
    <>
      <h1 className="font-display text-[1.7rem] font-bold leading-tight tracking-[-0.02em] text-ink">{title}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{sub}</p>
    </>
  );
}

export function AuthSubmit({
  loading, loadingLabel, children, ...props
}: { loading?: boolean; loadingLabel: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart'>) {
  return (
    <motion.button
      type="submit"
      whileTap={props.disabled ? undefined : { scale: 0.98 }}
      {...props}
      className="relative mt-5 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-ink px-4 py-3 text-sm font-semibold text-ground outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-ground-2 enabled:hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? loadingLabel : children}
      {!loading && <ArrowRight size={16} />}
      {/* the accent only ever appears as a rule */}
      <span aria-hidden className="absolute inset-x-4 -bottom-px h-0.5 rounded-full bg-[var(--accent)]" />
    </motion.button>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-alert">
      <AlertCircle size={16} className="mt-0.5 shrink-0" />
      {children}
    </p>
  );
}

export function AuthNotice({ icon: Icon = Info, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <p className="mb-5 flex items-start gap-2.5 border-l-2 border-[var(--accent)] pl-3 text-sm leading-relaxed text-ink-2">
      <Icon size={16} className="mt-0.5 shrink-0 text-[var(--accent)]" />
      {children}
    </p>
  );
}

export function AuthDivider() {
  return (
    <div className="my-5 flex items-center gap-3" aria-hidden>
      <span className="h-px flex-1 bg-hairline" />
      <span className="text-[10.5px] uppercase tracking-[0.12em] text-muted">or</span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}

const LINK_CLASS =
  'cursor-pointer font-semibold text-[var(--accent)] underline-offset-4 outline-none hover:underline focus-visible:underline';

export function AuthLink(props: LinkProps) {
  return <Link {...props} className={LINK_CLASS} />;
}

export function AuthLinkButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...props} className={LINK_CLASS}>
      {children}
    </button>
  );
}

export function AuthTextButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="mt-4 w-full cursor-pointer text-center text-sm font-medium text-ink-2 underline-offset-4 outline-none hover:text-ink hover:underline focus-visible:underline"
    >
      {children}
    </button>
  );
}
