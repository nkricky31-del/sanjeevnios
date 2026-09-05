import { useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';

import PatientDeclarationGate from './components/PatientDeclarationGate';
import PatientOnboardingGate from './components/PatientOnboardingGate';
import EncounterDetail from './components/EncounterDetail';
import NotificationsList from './components/NotificationsList';
import BottomTabBar from './components/ui/BottomTabBar';
import Button from './components/ui/Button';
import PlatformFooterNote from './components/ui/PlatformFooterNote';
import { useAuth } from './lib/AuthContext';
import { CLINIC_SIGNUP_INTENT_KEY } from './lib/clinicSignupIntent';
import { supabase } from './lib/supabaseClient';
import AdminConsole from './pages/AdminConsole';
import BookingPass from './pages/BookingPass';
import BookingStatus from './pages/BookingStatus';
import ClinicQueue from './pages/ClinicQueue';
import ClinicPoster from './pages/ClinicPoster';
import ClinicSignup from './pages/ClinicSignup';
import DoctorPage from './pages/DoctorPage';
import Home from './pages/Home';
import Login from './pages/Login';
import MyBookings from './pages/MyBookings';
import Payments from './pages/Payments';
import Profile from './pages/Profile';
import Records from './pages/Records';
import Search from './pages/Search';
import TokenBoard from './pages/TokenBoard';

export default function App() {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  const [signupIntent, setSignupIntent] = useState(false);

  // Login.tsx sets this flag the moment someone picks "Register your clinic"
  // BEFORE they've even signed in - re-check it every time `session` flips
  // from signed-out to signed-in, which is exactly when a login just completed.
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

  if (!session) return <Login />;
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

  if (profile.role === 'clinic') {
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

  if (profile.role === 'admin') {
    return (
      <div className="min-h-screen bg-canvas">
        <AdminConsole />
      </div>
    );
  }

  // A fresh/existing patient who chose "Register your clinic" on the login
  // screen lands here instead of the normal patient home screen. Once
  // register_clinic() succeeds, profile.role flips to 'clinic' and the
  // branch above takes over on the very next render.
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
          </Routes>
          <PlatformFooterNote />
          <BottomTabBar />
        </div>
      </PatientDeclarationGate>
    </PatientOnboardingGate>
  );
}
