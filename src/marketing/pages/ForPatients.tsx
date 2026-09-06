import { BellRing, CheckCircle2, FileText, Search, Ticket } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import { useDocumentMeta } from '../lib/useDocumentMeta';

const STEPS = [
  {
    icon: Search,
    title: '1. Find a doctor',
    body: 'Search nearby clinics and doctors by name or specialty - only verified, approved clinics show up.',
  },
  {
    icon: Ticket,
    title: '2. Book a slot',
    body: 'Pick a time that works, or walk in - either way, you get a live position in the queue.',
  },
  {
    icon: BellRing,
    title: '3. Get notified',
    body: "We'll let you know as your turn approaches, so you don't have to sit and watch a board.",
  },
  {
    icon: FileText,
    title: '4. Keep your records',
    body: 'Prescriptions and visit notes stay in your account, searchable across every clinic you visit.',
  },
];

const BENEFITS = [
  'One MRN that follows you across every SanjeevniOS clinic',
  'A real-time token - no more guessing when you\'ll be seen',
  'Optional online payment for a smoother, faster check-in',
  'All your prescriptions and visit history in one place',
  'DPDP-aligned consent - you control what\'s shared and with whom',
];

export default function ForPatients() {
  useDocumentMeta(
    'For Patients — SanjeevniOS',
    'Book verified clinics and doctors, track your live queue position, and keep every prescription and visit record in one place with SanjeevniOS.'
  );
  const navigate = useNavigate();

  return (
    <div>
      <section className="bg-gradient-to-br from-brand-700 to-brand-500">
        <div className="mx-auto max-w-4xl px-5 py-16 text-center text-white">
          <h1 className="text-3xl font-extrabold sm:text-4xl">Book your next visit in minutes</h1>
          <p className="mx-auto mt-3 max-w-xl text-brand-50">
            Find a verified clinic, book a slot, and track your live queue position - right up to the moment you're
            called in.
          </p>
          <Button
            variant="coral"
            className="mt-6 !px-6 !py-3.5 text-base"
            onClick={() => navigate('/login')}
          >
            Get the app / Login
          </Button>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 py-14">
        <h2 className="text-center text-2xl font-extrabold text-slate-900">How it works</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {STEPS.map((s) => (
            <Card key={s.title}>
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
                <s.icon size={22} />
              </div>
              <p className="mt-3 font-bold text-slate-900">{s.title}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{s.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="bg-white py-14">
        <div className="mx-auto max-w-3xl px-5">
          <h2 className="text-center text-2xl font-extrabold text-slate-900">Why patients use SanjeevniOS</h2>
          <div className="mt-6 space-y-3">
            {BENEFITS.map((b) => (
              <div key={b} className="flex items-start gap-2.5">
                <CheckCircle2 size={19} className="mt-0.5 shrink-0 text-brand-600" />
                <p className="text-sm text-slate-600">{b}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center">
            <Button variant="primary" className="!px-6 !py-3.5 text-base" onClick={() => navigate('/login')}>
              Get the app / Login
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
