import { CalendarCheck, ClipboardList, ShieldCheck, Stethoscope, UserRound, UsersRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import LiveStats from '../components/LiveStats';
import { useDocumentMeta } from '../lib/useDocumentMeta';

const HOW_IT_WORKS = [
  {
    icon: UserRound,
    title: 'Patients book in seconds',
    body: 'Search nearby clinics, pick a doctor and a time slot, and get a live token the moment you check in - no waiting-room guesswork.',
  },
  {
    icon: ClipboardList,
    title: 'Clinics run the whole visit',
    body: 'Check-in, queue, consultation notes, and prescriptions all live in one dashboard - from the front desk to the doctor.',
  },
  {
    icon: ShieldCheck,
    title: 'Verified before going live',
    body: 'Every clinic and doctor is document-verified by our admin team before they ever appear in patient search.',
  },
];

const FOR_WHOM = [
  {
    icon: Stethoscope,
    title: 'For Clinics',
    body: 'Register your clinic and doctors, manage your daily queue, and get discovered by patients nearby.',
    to: '/for-clinics',
  },
  {
    icon: UsersRound,
    title: 'For Patients',
    body: 'Find a doctor, book an appointment, and keep every visit, prescription, and record in one place.',
    to: '/for-patients',
  },
];

export default function MarketingHome() {
  useDocumentMeta(
    'SanjeevniOS — Clinic bookings, queues & records',
    'SanjeevniOS connects patients and clinics: book appointments, manage live queues, and keep every visit and prescription in one verified, DPDP-compliant platform.'
  );
  const navigate = useNavigate();

  return (
    <div>
      {/* Hero */}
      <section className="bg-gradient-to-br from-brand-700 via-brand-600 to-brand-500">
        <div className="mx-auto max-w-6xl px-5 pb-16 pt-14 sm:pt-20">
          <div className="max-w-2xl">
            <p className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-bold text-white">
              <ShieldCheck size={14} /> Verified clinics & doctors only
            </p>
            <h1 className="mt-4 text-4xl font-extrabold leading-tight text-white sm:text-5xl">
              Book a clinic visit, or run one - all in one place.
            </h1>
            <p className="mt-4 text-base leading-relaxed text-brand-50 sm:text-lg">
              SanjeevniOS is the platform behind the appointment: live queues, verified doctors, digital
              prescriptions, and a booking flow patients actually enjoy using.
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Button variant="coral" className="!px-6 !py-3.5 text-base" onClick={() => navigate('/clinic/login?mode=register')}>
                Join us — Register your clinic
              </Button>
              <Button
                variant="outline"
                className="!border-white/40 !bg-white/10 !px-6 !py-3.5 !text-base !text-white hover:!bg-white/20"
                onClick={() => navigate('/login')}
              >
                Get the app / Login
              </Button>
            </div>
          </div>

          <div className="mt-12">
            <LiveStats />
          </div>
        </div>
      </section>

      {/* What we are / do */}
      <section className="mx-auto max-w-6xl px-5 py-14">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">What SanjeevniOS is</h2>
          <p className="mt-3 text-slate-500">
            A clinic operations platform with a patient booking app built on top of it - the same live queue a
            patient sees on their phone is the one the front desk is running from, so nothing ever goes out of sync.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {HOW_IT_WORKS.map((s) => (
            <Card key={s.title} className="text-left">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
                <s.icon size={22} />
              </div>
              <p className="mt-3 font-bold text-slate-900">{s.title}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{s.body}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* For clinics / for patients */}
      <section className="bg-white py-14">
        <div className="mx-auto max-w-6xl px-5">
          <h2 className="text-center text-2xl font-extrabold text-slate-900 sm:text-3xl">Built for both sides of the visit</h2>
          <div className="mt-10 grid gap-5 sm:grid-cols-2">
            {FOR_WHOM.map((f) => (
              <Card key={f.title} className="flex flex-col items-start">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
                  <f.icon size={24} />
                </div>
                <p className="mt-3 text-lg font-bold text-slate-900">{f.title}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{f.body}</p>
                <Button variant="outline" className="mt-4" onClick={() => navigate(f.to)}>
                  Learn more
                </Button>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-6xl px-5 py-14">
        <Card className="flex flex-col items-center gap-4 !rounded-[2rem] bg-brand-700 !border-0 py-10 text-center text-white">
          <CalendarCheck size={30} />
          <h2 className="text-2xl font-extrabold sm:text-3xl">Ready to get started?</h2>
          <p className="max-w-md text-sm text-brand-100">
            Clinics can be onboarded in minutes. Patients can book their first appointment right after signing in.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button variant="coral" onClick={() => navigate('/clinic/login?mode=register')}>
              Join us — Register your clinic
            </Button>
            <Button
              variant="outline"
              className="!border-white/40 !bg-transparent !text-white hover:!bg-white/10"
              onClick={() => navigate('/login')}
            >
              Get the app / Login
            </Button>
          </div>
        </Card>
      </section>
    </div>
  );
}
