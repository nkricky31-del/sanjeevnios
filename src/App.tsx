import { Route, Routes } from 'react-router-dom';

import BottomTabBar from './components/ui/BottomTabBar';
import { useAuth } from './lib/AuthContext';
import BookingStatus from './pages/BookingStatus';
import ClinicQueue from './pages/ClinicQueue';
import DoctorPage from './pages/DoctorPage';
import Login from './pages/Login';
import MyBookings from './pages/MyBookings';
import Profile from './pages/Profile';
import Search from './pages/Search';
import Timeline from './pages/Timeline';

export default function App() {
  const { session, profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  }

  if (!session) return <Login />;
  if (!profile) return null;

  if (profile.role === 'clinic') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClinicQueue />
      </div>
    );
  }

  if (profile.role === 'admin') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-400">Admin dashboard isn't built yet.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20">
      <Routes>
        <Route path="/" element={<Search />} />
        <Route path="/doctors/:doctorId" element={<DoctorPage />} />
        <Route path="/bookings" element={<MyBookings />} />
        <Route path="/bookings/:appointmentId" element={<BookingStatus />} />
        <Route path="/timeline" element={<Timeline />} />
        <Route path="/profile" element={<Profile />} />
      </Routes>
      <BottomTabBar />
    </div>
  );
}
