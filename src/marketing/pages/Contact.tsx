import { PageHead } from '../components/PageParts';
import { Label, Reveal } from '../components/motionKit';
import { useDocumentMeta } from '../lib/useDocumentMeta';

// Placeholder contact details tied to the domain suggested for this site -
// replace with the real support inbox/number/address before launch.
const CONTACTS = [
  { label: 'Email', value: 'hello@sanjeevnios.in', href: 'mailto:hello@sanjeevnios.in' },
  { label: 'Phone', value: '+91 00000 00000', href: 'tel:+910000000000' },
  { label: 'Office', value: 'Bengaluru, Karnataka, India', href: null as string | null },
];

export default function Contact() {
  useDocumentMeta('Contact — SanjeevniOS', 'Get in touch with the SanjeevniOS team - email, phone, or our office address.');
  return (
    <div className="pb-16">
      <PageHead
        eyebrow="Contact"
        title="Get in touch."
        lede="Questions about registering your clinic, using the app, or anything else: we would love to hear from you."
      />
      <div className="mx-auto max-w-6xl px-5">
        <div className="border-t border-hairline">
          {CONTACTS.map((c, i) => (
            <Reveal key={c.label} delay={i * 0.05} y={12}>
              <div className="grid gap-1 border-b border-hairline py-6 md:grid-cols-[10rem_1fr] md:gap-8">
                <Label accent="amber" className="pt-1.5">{c.label}</Label>
                {c.href ? (
                  <a href={c.href} className="w-fit font-display text-xl font-bold tracking-[-0.02em] text-ink outline-none transition-colors hover:text-amber focus-visible:text-amber sm:text-2xl">
                    {c.value}
                  </a>
                ) : (
                  <p className="font-display text-xl font-bold tracking-[-0.02em] text-ink sm:text-2xl">{c.value}</p>
                )}
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </div>
  );
}
