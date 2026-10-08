import { PageHead, RuleList } from '../components/PageParts';
import { useDocumentMeta } from '../lib/useDocumentMeta';

const VALUES = [
  { title: 'Built around the visit', body: 'Every feature exists to make one appointment go smoothly: from booking, to the waiting room, to the prescription a patient walks out with.' },
  { title: 'Verified, not just listed', body: 'Clinics and doctors go through a real document review before they ever appear in patient search: name, registration, qualifications and consent, all checked.' },
  { title: 'Privacy by default', body: 'Data consent is collected explicitly, and every record stays scoped to the account and clinic it belongs to.' },
  { title: 'Made for how clinics actually run', body: 'Walk-ins, advance bookings, late arrivals, holidays: the queue logic handles the messy real-world cases, not just the happy path.' },
];

export default function About() {
  useDocumentMeta(
    'About — SanjeevniOS',
    'SanjeevniOS is a verified clinic operations and patient booking platform - learn what we do and why we built it.'
  );
  return (
    <div className="pb-6">
      <PageHead
        eyebrow="About"
        title="One queue, shared by both sides."
        lede="The clinic front desk and the patient's phone are usually running two different pictures of the same queue. SanjeevniOS is one system they both share: the token a patient sees is the one the front desk just issued, the prescription a doctor writes is the one in the patient's records, and a clinic only appears in search once it has been verified."
      />
      <RuleList items={VALUES} />
    </div>
  );
}
