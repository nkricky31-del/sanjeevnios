import { CheckCircle2, FileCheck2, MapPin, Stethoscope, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import { useDocumentMeta } from '../lib/useDocumentMeta';

const STEPS = [
  {
    icon: Stethoscope,
    title: '1. Register your clinic',
    body: 'Sign in with your phone number, then enter your clinic name and registration number.',
  },
  {
    icon: MapPin,
    title: '2. Finish your details',
    body: 'Set your exact map location and upload your clinic registration certificate and other documents.',
  },
  {
    icon: Users,
    title: '3. Add at least one doctor',
    body: 'Add a doctor and submit their government ID, medical registration certificate, qualification certificate, photo, and signed agreement.',
  },
  {
    icon: FileCheck2,
    title: '4. Send for verification',
    body: 'Our admin team reviews everything - once approved, your clinic and doctors go live in patient search.',
  },
];

const BENEFITS = [
  'Live, self-updating patient queue - no shouting names across a waiting room',
  'Walk-ins and advance bookings handled by the same queue, fairly',
  'Digital prescriptions and visit notes, searchable per patient',
  'Online payments with automatic queue perks, never priority-for-pay',
  'Your own dashboard for holidays, availability, and billing',
];

export default function ForClinics() {
  useDocumentMeta(
    'For Clinics — SanjeevniOS',
    'Register your clinic on SanjeevniOS: add your doctors, get verified, and run your queue, bookings, and prescriptions from one dashboard.'
  );
  const navigate = useNavigate();

  return (
    <div>
      <section className="bg-gradient-to-br from-brand-700 to-brand-500">
        <div className="mx-auto max-w-4xl px-5 py-16 text-center text-white">
          <h1 className="text-3xl font-extrabold sm:text-4xl">Bring your clinic online</h1>
          <p className="mx-auto mt-3 max-w-xl text-brand-50">
            Registration takes a few minutes to start. Nothing goes live to patients until an admin verifies your
            clinic and every doctor on it.
          </p>
          <Button variant="coral" className="mt-6 !px-6 !py-3.5 text-base" onClick={() => navigate('/clinic/login?mode=register')}>
            Join us — Register your clinic
          </Button>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 py-14">
        <h2 className="text-center text-2xl font-extrabold text-slate-900">How registration works</h2>
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
          <h2 className="text-center text-2xl font-extrabold text-slate-900">What you get</h2>
          <div className="mt-6 space-y-3">
            {BENEFITS.map((b) => (
              <div key={b} className="flex items-start gap-2.5">
                <CheckCircle2 size={19} className="mt-0.5 shrink-0 text-brand-600" />
                <p className="text-sm text-slate-600">{b}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center">
            <Button variant="primary" className="!px-6 !py-3.5 text-base" onClick={() => navigate('/clinic/login?mode=register')}>
              Join us — Register your clinic
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
