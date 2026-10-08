import { Checklist, PageHead, PillButton, RuleList } from '../components/PageParts';
import { useDocumentMeta } from '../lib/useDocumentMeta';

const STEPS = [
  { title: 'Find a doctor', body: 'Search nearby clinics and doctors by name or specialty. Only verified, approved clinics show up.' },
  { title: 'Book a slot', body: 'Pick a time that works, or walk in. Either way you get a live position in the queue.' },
  { title: 'Get notified', body: "We'll let you know as your turn approaches, so you don't have to sit and watch a board." },
  { title: 'Keep your records', body: 'Prescriptions and visit notes stay in your account, searchable across every clinic you visit.' },
];

const BENEFITS = [
  'One MRN that follows you across every SanjeevniOS clinic',
  'A real-time token: no more guessing when you will be seen',
  'Optional online payment for a smoother, faster check-in',
  'All your prescriptions and visit history in one place',
  'Consent you control: you decide what is shared, and with whom',
];

export default function ForPatients() {
  useDocumentMeta(
    'For Patients — SanjeevniOS',
    'Book verified clinics and doctors, track your live queue position, and keep every prescription and visit record in one place with SanjeevniOS.'
  );
  return (
    <div>
      <PageHead
        eyebrow="For patients"
        title="Book your next visit in minutes."
        lede="Find a verified clinic, book a slot, and track your live queue position, right up to the moment you're called in."
      >
        <PillButton to="/login">Book a visit</PillButton>
      </PageHead>
      <RuleList items={STEPS} />
      <Checklist title="Why patients use it" items={BENEFITS} />
      <div className="mx-auto max-w-6xl px-5 py-16">
        <PillButton to="/login">Book a visit</PillButton>
      </div>
    </div>
  );
}
