import { Link } from 'react-router-dom';

const COLUMNS = [
  { title: 'Product', links: [{ to: '/for-patients', label: 'For patients' }, { to: '/for-clinics', label: 'For clinics' }] },
  { title: 'Company', links: [{ to: '/about', label: 'About' }, { to: '/contact', label: 'Contact' }] },
  {
    title: 'Account',
    links: [
      { to: '/login', label: 'Patient sign in' },
      { to: '/clinic/login', label: 'Clinic sign in' },
      { to: '/clinic/login?mode=register', label: 'Register your clinic' },
    ],
  },
];

// A hairline strip of links, then the wordmark at full width, nudged down so
// the bottom edge of the page crops it.
export default function MarketingFooter() {
  return (
    <footer className="overflow-hidden border-t border-hairline bg-ground">
      <div className="mx-auto max-w-6xl px-5 pt-12">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {COLUMNS.map((c) => (
            <div key={c.title}>
              <p className="font-ui text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">{c.title}</p>
              <div className="mt-3 flex flex-col gap-2.5">
                {c.links.map((l) => (
                  <Link
                    key={l.to}
                    to={l.to}
                    className="w-fit font-ui text-sm text-ink-2 outline-none transition-colors hover:text-primary focus-visible:text-primary"
                  >
                    {l.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-10 border-t border-hairline pt-5 font-ui text-xs text-muted">
          © {new Date().getFullYear()} SanjeevniOS. All rights reserved.
        </p>
      </div>
      <p
        aria-hidden
        className="mx-auto mt-4 translate-y-[26%] select-none whitespace-nowrap text-center font-display text-[9.4vw] font-extrabold leading-[0.85] tracking-[-0.04em] text-ink/90"
      >
        SanjeevniOS
      </p>
    </footer>
  );
}
