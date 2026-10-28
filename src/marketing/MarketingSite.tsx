import { useEffect, useLayoutEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';

import { useDarkBackdrop } from '../lib/useDarkBackdrop';

import MarketingFooter from './components/MarketingFooter';
import MarketingNav from './components/MarketingNav';
import About from './pages/About';
import Contact from './pages/Contact';
import ForClinics from './pages/ForClinics';
import ForPatients from './pages/ForPatients';
import MarketingHome from './pages/MarketingHome';

// The public marketing site (no login required) - App.tsx mounts this ONLY
// for a signed-out visitor on one of the paths below; everything else while
// signed out (including a bare, unrecognized path) still falls through to
// Login.tsx exactly as before. This has its own nested <Routes> rather than
// being registered on the app's root Routes - BrowserRouter already sits at
// the very top in main.tsx, so a nested Routes tree here works the same way
// it does for any other sub-section of the app.
export default function MarketingSite() {
  useDarkBackdrop();
  const location = useLocation();

  // Every page opens at the top. The home page's opening animation is driven
  // by scroll position, so arriving part-way down (the previous page's scroll
  // carried over, or the browser restoring it on reload/back) showed it
  // already finished, as if it had been skipped. A link to a section
  // (state.scrollTo, see sectionNav.ts) still scrolls to that section.
  useLayoutEffect(() => {
    if ((location.state as { scrollTo?: string } | null)?.scrollTo) return;
    window.scrollTo(0, 0);
  }, [location.pathname, location.state]);

  // Stop the browser restoring an old scroll position on reload/back while the
  // marketing site is showing; the app's own screens keep the default.
  useEffect(() => {
    if (!('scrollRestoration' in history)) return;
    const previous = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => {
      history.scrollRestoration = previous;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-ground font-ui text-ink">
      <MarketingNav />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<MarketingHome />} />
          <Route path="/about" element={<About />} />
          <Route path="/for-clinics" element={<ForClinics />} />
          <Route path="/for-patients" element={<ForPatients />} />
          <Route path="/contact" element={<Contact />} />
        </Routes>
      </main>
      <MarketingFooter />
    </div>
  );
}
