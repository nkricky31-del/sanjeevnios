import { Mail, MapPin, Phone } from 'lucide-react';

import Card from '../../components/ui/Card';
import { useDocumentMeta } from '../lib/useDocumentMeta';

// Placeholder contact details tied to the domain suggested for this site -
// replace with the real support inbox/number/address before launch.
const CONTACTS = [
  { icon: Mail, label: 'Email', value: 'hello@sanjeevnios.in', href: 'mailto:hello@sanjeevnios.in' },
  { icon: Phone, label: 'Phone', value: '+91 00000 00000', href: 'tel:+910000000000' },
  { icon: MapPin, label: 'Office', value: 'Bengaluru, Karnataka, India', href: null },
];

export default function Contact() {
  useDocumentMeta('Contact — SanjeevniOS', 'Get in touch with the SanjeevniOS team - email, phone, or our office address.');

  return (
    <div className="mx-auto max-w-2xl px-5 py-14">
      <h1 className="text-3xl font-extrabold text-slate-900 sm:text-4xl">Get in touch</h1>
      <p className="mt-3 text-slate-500">
        Questions about registering your clinic, using the app, or anything else - we'd love to hear from you.
      </p>

      <div className="mt-8 space-y-3">
        {CONTACTS.map((c) => (
          <Card key={c.label} className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
              <c.icon size={20} />
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{c.label}</p>
              {c.href ? (
                <a href={c.href} className="text-sm font-semibold text-brand-600">
                  {c.value}
                </a>
              ) : (
                <p className="text-sm font-semibold text-slate-700">{c.value}</p>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
