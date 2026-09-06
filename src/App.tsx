import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import PatientDeclarationGate from './components/PatientDeclarationGate';
import PatientOnboardingGate from './components/PatientOnboardingGate';
import EncounterDetail from './components/EncounterDetail';
import NotificationsList from './components/NotificationsList';
import BottomTabBar from './components/ui/BottomTabBar';
import Button from './components/ui/Button';
import PlatformFooterNote from './components/ui/PlatformFooterNote';
import { getStoredActingMode } from './lib/actingMode';
import { useAuth } from './lib/AuthContext';
import { CLINIC_SIGNUP_INTENT_KEY } from './lib/clinicSignupIntent';
import { supabase } from './lib/supabaseClient';
import MarketingSite from './marketing/MarketingSite';
import AdminConsole from './pages/AdminConsole';
import AdminLogin from './pages/AdminLogin';
import BookingPass from './pages/BookingPass';
import BookingStatus from './pages/BookingStatus';
import ClinicLogin from './pages/ClinicLogin';
import ClinicQueue from './pages/ClinicQueue';
import ClinicPoster from './pages/ClinicPoster';
import ClinicSignup from './pages/ClinicSignup';
import DoctorPage from './pages/DoctorPage';
import Home from './pages/Home';
import MyBookings from './pages/MyBookings';
import PatientLogin from './pages/PatientLogin';
import Payments from './pages/Payments';
import Profile from './pages/Profile';
import Records from './pages/Records';
import Search from './pages/Search';
import TokenBoard from './pages/TokenBoard';

export default function App() {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  const [signupIntent, setSignupIntent] = useState(false);

  // ClinicLogin.tsx sets this flag the moment someone picks "Register your
  // clinic" BEFORE they've even signed in - re-check it every time `session`
  // flips from signed-out to signed-in, which is exactly when a login just completed.
  useEffect(() => {
    if (session) {
      setSignupIntent(sessionStorage.getItem(CLINIC_SIGNUP_INTENT_KEY) === '1');
    }
  }, [session]);

  const clearSignupIntent = () => {
    sessionStorage.removeItem(CLINIC_SIGNUP_INTENT_KEY);
    setSignupIntent(false);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  }

  // PUBLIC vs PRIVATE, enforced here as a real redirect (not just "render
  // Login inline") so the address bar and browser history both reflect it -
  // this is the convenience layer only. Every table a private page reads
  // from already requires a valid session at the RLS/RPC level regardless
  // of what the UI does (profiles/appointments/visits/prescriptions/
  // documents/etc. all key off auth.uid()/is_admin()/is_own_clinic() - see
  // TESTING.md for how to verify that directly), so a bypassed redirect
  // still can't read another account's data.
  const PUBLIC_PATHS = ['/', '/about', '/for-clinics', '/for-patients', '/contact'];
  if (!session) {
    if (PUBLIC_PATHS.includes(location.pathname)) return <MarketingSite />;
    // Three separate, role-aware login screens - each its own URL and its
    // own look (PatientLogin.tsx / ClinicLogin.tsx / AdminLogin.tsx) - so
    // none of them are itself a redirect target. Every OTHER private path
    // bounces to the patient login with ?next=<path> so it can send the
    // visitor back once they're signed in; a visitor who actually wanted
    // the clinic or admin console navigates there directly (the links on
    // PatientLogin, or a bookmarked /clinic/login or /admin/login).
    if (location.pathname === '/login') return <PatientLogin />;
    if (location.pathname === '/clinic/login') return <ClinicLogin />;
    if (location.pathname === '/admin/login') return <AdminLogin />;
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (!profile) return null;

  // A suspended account can't create new bookings at the DB level (RLS)
  // regardless of what the UI does - this just makes that state legible
  // instead of leaving them stuck on forms that silently fail.
  if (profile.suspended) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-sm rounded-2xl border border-red-100 bg-white p-6 text-center shadow-sm">
          <p className="text-lg font-bold text-slate-900">Account suspended</p>
          <p className="mt-2 text-sm text-slate-500">
            Your account has been suspended by an admin. You can't make new bookings while suspended. Contact
            support if you think this is a mistake.
          </p>
          <Button variant="ghost" onClick={() => supabase.auth.signOut()} className="mt-4">
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  // A direct link to one encounter - reachable by any role, regardless of
  // the role-specific screens below (typed/pasted URL, not a normal nav
  // click). This has to work independently of role because access here is
  // decided ENTIRELY by encounters RLS (see schema.sql section 20): the
  // fetch inside EncounterDetail just asks for this id and either gets the
  // row back or doesn't - a clinic pasting another clinic's encounter link
  // gets "not found", not a client-side redirect, since Postgres itself
  // never returns the row.
  const encounterMatch = location.pathname.match(/^\/encounters\/([^/]+)$/);
  if (encounterMatch) {
    return (
      <div className="min-h-screen bg-canvas">
        <EncounterDetail encounterId={encounterMatch[1]} />
      </div>
    );
  }

  // Same idea as the encounter route above - reachable by any role via the
  // bell icon on every AppHeader (see useUnreadNotifications.ts), regardless
  // of which role-specific screen they're currently on.
  if (location.pathname === '/notifications') {
    return (
      <div className="min-h-screen bg-canvas">
        <NotificationsList />
      </div>
    );
  }

  // Admin is checked first, unconditionally, and never joins the mode
  // switch below - unlike patient/clinic, this app never asks anyone to be
  // "an admin AND something else" (schema.sql migration 58's own header
  // explains why patient/clinic can't avoid it: one phone, one auth.users
  // row, no second account to keep separate - admin was never meant to have
  // that problem, so it doesn't get the same escape hatch).
  if (profile.role === 'admin') {
    return (
      <div className="min-h-screen bg-canvas">
        <AdminConsole />
      </div>
    );
  }

  // A fresh/existing patient who chose "Register your clinic" on the login
  // screen lands here instead of either shell below. Checked before the
  // mode switch because ClinicLogin.tsx's register flow already sets the
  // acting mode to 'clinic' at submit time (see actingMode.ts) even though
  // there's no clinic row yet - without this check first, that would render
  // ClinicQueue's "no clinic found" fallback instead of this registration
  // form. Once register_clinic_quick_start() succeeds, ClinicSignup's
  // finish() clears this flag AND calls refreshProfile() (role flips to
  // 'clinic'), so the mode branch below takes over on the very next render.
  if (signupIntent) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8">
        <div className="w-full max-w-sm">
          <ClinicSignup onRegistered={clearSignupIntent} />
          <button
            onClick={clearSignupIntent}
            className="mt-4 block w-full text-center text-sm font-medium text-slate-500"
          >
            Cancel — continue as a patient
          </button>
        </div>
      </div>
    );
  }

  // ONE PHONE, TWO ROLES (schema.sql migration 58): a clinic owner or staff
  // phone (clinic_staff_phones, migration 57) is ALSO a patient under this
  // same account - there is no second profiles row to route by, so which
  // shell this SESSION sees is decided by actingMode.ts, not by
  // profile.role alone. PatientLogin.tsx / ClinicLogin.tsx each set it the
  // moment their own form is submitted; the "Switch to..." actions in
  // Profile.tsx / ClinicQueue.tsx flip it explicitly mid-session. Falling
  // back to profile.role only matters for a session that hasn't made an
  // explicit choice yet (a fresh tab picking up an already-persisted
  // Supabase session) - it keeps an existing single-role clinic owner
  // landing straight in their console, exactly as before this existed.
  //
  // This is still just the Part 50 UI convenience layer, same as the
  // signed-in/signed-out check above it: the REAL boundary is RLS
  // (is_own_clinic()/is_admin(), unaffected by which shell is on screen), so
  // even hand-editing this session's stored mode in devtools can't expose
  // another account's data - at worst it shows this same account's OWN
  // patient view, or an empty "no clinic found" state if it has none.
  const mode = getStoredActingMode() ?? (profile.role === 'clinic' ? 'clinic' : 'patient');

  if (mode === 'clinic') {
    // Both of these are full-bleed screens meant for a second monitor or a
    // tablet facing the waiting room, so they carry no console chrome.
    if (location.pathname === '/board') return <TokenBoard />;
    if (location.pathname === '/poster') return <ClinicPoster />;
    return (
      <div className="min-h-screen bg-canvas">
        <ClinicQueue />
      </div>
    );
  }

  return (
    <PatientOnboardingGate>
      <PatientDeclarationGate>
        <div className="min-h-screen bg-canvas pb-24">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/search" element={<Search />} />
            <Route path="/doctors/:doctorId" element={<DoctorPage />} />
            <Route path="/bookings" element={<MyBookings />} />
            <Route path="/bookings/:appointmentId" element={<BookingStatus />} />
            <Route path="/bookings/:appointmentId/pass" element={<BookingPass />} />
            <Route path="/records" element={<Records />} />
            <Route path="/payments" element={<Payments />} />
            {/* Kept so old links/bookmarks to the timeline still land somewhere. */}
            <Route path="/timeline" element={<Records />} />
            <Route path="/profile" element={<Profile />} />
            {/* Role-aware guard's other half: a patient account typing a
                clinic/admin-only URL (/admin, /board, /poster, or anything
                else that isn't one of this role's own routes above) lands
                here instead of a blank content area, and is sent to their
                own home - never a broken/empty page. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <PlatformFooterNote />
          <BottomTabBar />
        </div>
      </PatientDeclarationGate>
    </PatientOnboardingGate>
  );
}
