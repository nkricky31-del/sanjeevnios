import { Checklist, PageHead, PillButton, RuleList } from '../components/PageParts';
import { useDocumentMeta } from '../lib/useDocumentMeta';

const STEPS = [
  { title: 'Register your clinic', body: 'Sign in with your phone number, then enter your clinic name and registration number.' },
  { title: 'Finish your details', body: 'Set your exact map location and upload your clinic registration certificate and other documents.' },
  { title: 'Add at least one doctor', body: 'Add a doctor and submit their government ID, medical registration certificate, qualification certificate, photo and signed agreement.' },
  { title: 'Send for verification', body: 'Our admin team reviews everything. Once approved, your clinic and doctors go live in patient search.' },
];

const BENEFITS = [
  'A live, self-updating patient queue: no shouting names across a waiting room',
  'Walk-ins and advance bookings handled by the same queue, fairly',
  'Digital prescriptions and visit notes, searchable per patient',
  'Online payments with convenience perks, never priority-for-pay',
  'Your own dashboard for holidays, availability and billing',
];

export default function ForClinics() {
  useDocumentMeta(
    'For Clinics — SanjeevniOS',
    'Register your clinic on SanjeevniOS: add your doctors, get verified, and run your queue, bookings, and prescriptions from one dashboard.'
  );
  return (
    <div>
      <PageHead
        eyebrow="For clinics"
        accent="primary"
        title="Bring your clinic online."
        lede="Registration takes a few minutes to start. Nothing goes live to patients until an admin verifies your clinic and every doctor on it."
      >
        <PillButton to="/clinic/login?mode=register">Register your clinic</PillButton>
      </PageHead>
      <RuleList items={STEPS} accent="primary" />
      <Checklist title="What you get" items={BENEFITS} accent="primary" />
      <div className="mx-auto max-w-6xl px-5 py-16">
        <PillButton to="/clinic/login?mode=register">Register your clinic</PillButton>
      </div>
    </div>
  );
}
