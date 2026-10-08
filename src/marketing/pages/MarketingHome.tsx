import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import CloseSection from '../components/CloseSection';
import PortalHero from '../components/PortalHero';
import ProductDeck from '../components/ProductDeck';
import Roster from '../components/Roster';
import StatementFold from '../components/StatementFold';
import VisitTable from '../components/VisitTable';
import { useDocumentMeta } from '../lib/useDocumentMeta';
import { scrollToSection } from '../lib/sectionNav';

// Six sections: portal hero, statement fold, the product deck, the live roster,
// the visit table, and the close (whose cropped wordmark is in the footer).
export default function MarketingHome() {
  useDocumentMeta(
    'SanjeevniOS — Clinic bookings, queues & records',
    'SanjeevniOS connects patients and clinics: book appointments, manage live queues, and keep every visit and prescription in one verified platform.'
  );
  const location = useLocation();
  useEffect(() => {
    const id = (location.state as { scrollTo?: string } | null)?.scrollTo;
    if (id) window.setTimeout(() => scrollToSection(id), 150);
  }, [location.state]);
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
