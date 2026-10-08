import { useNavigate } from 'react-router-dom';

import { Label, Reveal } from './motionKit';

// A short headline, a fine-print line, two buttons at the opposite edge. The
// footer below it carries the cropped wordmark.
export default function CloseSection() {
  const navigate = useNavigate();
  return (
    <section className="bg-ground py-28">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 md:flex-row md:items-end md:justify-between">
        <div>
          <Reveal><Label accent="leaf">Get started</Label></Reveal>
          <Reveal delay={0.08}>
            <h2 className="mt-5 max-w-[14ch] font-display text-[clamp(36px,6vw,84px)] font-extrabold leading-[0.98] tracking-[-0.035em] text-ink">
              Run the whole visit from one place.
            </h2>
          </Reveal>
          <Reveal delay={0.16}>
            <p className="mt-5 max-w-sm font-ui text-sm leading-relaxed text-ink-2">
              Clinics are document-verified before they go live. Patients can book as soon as they sign in.
            </p>
          </Reveal>
        </div>
        <Reveal delay={0.24} className="flex shrink-0 flex-col gap-3 sm:flex-row">
          <button type="button" onClick={() => navigate('/clinic/login?mode=register')}
            className="shrink-0 cursor-pointer whitespace-nowrap rounded-full bg-primary px-7 py-3.5 font-ui text-sm font-semibold text-white outline-none transition hover:bg-primary-dark focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-ground">
            Register your clinic
          </button>
          <button type="button" onClick={() => navigate('/login')}
            className="shrink-0 cursor-pointer whitespace-nowrap rounded-full border border-ink/40 px-7 py-3.5 font-ui text-sm font-semibold text-ink outline-none transition hover:border-leaf-text hover:text-leaf-text focus-visible:ring-2 focus-visible:ring-leaf-text">
            Sign in
          </button>
        </Reveal>
      </div>
    </section>
  );
}
