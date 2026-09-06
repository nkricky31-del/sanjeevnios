import { Route, Routes } from 'react-router-dom';

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
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
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
