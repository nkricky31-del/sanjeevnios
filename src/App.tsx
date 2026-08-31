import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';

import PatientDeclarationGate from './components/PatientDeclarationGate';
import BottomTabBar from './components/ui/BottomTabBar';
import Button from './components/ui/Button';
import PlatformFooterNote from './components/ui/PlatformFooterNote';
import { useAuth } from './lib/AuthContext';
import { CLINIC_SIGNUP_INTENT_KEY } from './lib/clinicSignupIntent';
import { supabase } from './lib/supabaseClient';
import AdminConsole from './pages/AdminConsole';
import BookingStatus from './pages/BookingStatus';
import ClinicQueue from './pages/ClinicQueue';
import ClinicSignup from './pages/ClinicSignup';
import DoctorPage from './pages/DoctorPage';
import Login from './pages/Login';
import MyBookings from './pages/MyBookings';
import Profile from './pages/Profile';
import Search from './pages/Search';
import Timeline from './pages/Timeline';

export default function App() {
  const { session, profile, loading } = useAuth();
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
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
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
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
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

  if (profile.role === 'clinic') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClinicQueue />
      </div>
    );
  }

  if (profile.role === 'admin') {
    return (
      <div className="min-h-screen bg-slate-50">
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
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-8">
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
    <PatientDeclarationGate>
      <div className="min-h-screen bg-slate-50 pb-20">
        <Routes>
          <Route path="/" element={<Search />} />
          <Route path="/doctors/:doctorId" element={<DoctorPage />} />
          <Route path="/bookings" element={<MyBookings />} />
          <Route path="/bookings/:appointmentId" element={<BookingStatus />} />
          <Route path="/timeline" element={<Timeline />} />
          <Route path="/profile" element={<Profile />} />
        </Routes>
        <PlatformFooterNote />
        <BottomTabBar />
      </div>
    </PatientDeclarationGate>
  );
}
