import CloseSection from '../components/CloseSection';
import PortalHero from '../components/PortalHero';
import ProductDeck from '../components/ProductDeck';
import Roster from '../components/Roster';
import StatementFold from '../components/StatementFold';
import VisitTable from '../components/VisitTable';
import { useDocumentMeta } from '../lib/useDocumentMeta';

// Six sections: portal hero, statement fold, the product deck, the live roster,
// the visit table, and the close (whose cropped wordmark is in the footer).
export default function MarketingHome() {
  useDocumentMeta(
    'SanjeevniOS — Clinic bookings, queues & records',
    'SanjeevniOS connects patients and clinics: book appointments, manage live queues, and keep every visit and prescription in one verified platform.'
  );
  return (
    <div>
      <PortalHero />
      <StatementFold />
      <ProductDeck />
      <Roster />
      <VisitTable />
      <CloseSection />
    </div>
  );
}
