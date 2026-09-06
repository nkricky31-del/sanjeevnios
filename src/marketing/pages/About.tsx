import { HeartHandshake, Lock, ShieldCheck, Sparkles } from 'lucide-react';

import Card from '../../components/ui/Card';
import { useDocumentMeta } from '../lib/useDocumentMeta';

const VALUES = [
  {
    icon: HeartHandshake,
    title: 'Built around the visit',
    body: 'Every feature exists to make one appointment go smoothly - from booking, to the waiting room, to the prescription a patient walks out with.',
  },
  {
    icon: ShieldCheck,
    title: 'Verified, not just listed',
    body: 'Clinics and doctors go through a real document review before they ever appear in patient search - name, registration, qualifications, and consent, all checked.',
  },
  {
    icon: Lock,
    title: 'Privacy by default',
    body: 'DPDP-aligned data consent is collected explicitly, and every record stays scoped to the account and clinic it belongs to.',
  },
  {
    icon: Sparkles,
    title: 'Made for how clinics actually run',
    body: 'Walk-ins, advance bookings, late arrivals, holidays - the queue logic handles the messy real-world cases, not just the happy path.',
  },
];

export default function About() {
  useDocumentMeta(
    'About — SanjeevniOS',
    'SanjeevniOS is a verified clinic operations and patient booking platform - learn what we do and why we built it.'
  );

  return (
    <div className="mx-auto max-w-4xl px-5 py-14">
      <h1 className="text-3xl font-extrabold text-slate-900 sm:text-4xl">About SanjeevniOS</h1>
      <p className="mt-4 text-base leading-relaxed text-slate-600">
        SanjeevniOS started from a simple observation: the clinic front desk and the patient's phone are usually
        running two completely different pictures of the same queue. We built one system that both sides actually
        share - the token a patient sees is the exact same token the front desk just issued, the prescription a
        doctor writes is the one that shows up in the patient's records, and a clinic only appears in search once
        it's actually been verified.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {VALUES.map((v) => (
          <Card key={v.title}>
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
              <v.icon size={22} />
            </div>
            <p className="mt-3 font-bold text-slate-900">{v.title}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{v.body}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
