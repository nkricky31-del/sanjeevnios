import { Navigate, Route, Routes } from 'react-router-dom';

import PatientDeclarationGate from './components/PatientDeclarationGate';
import PatientOnboardingGate from './components/PatientOnboardingGate';
import PatientShell from './components/shell/PatientShell';
import BookingPass from './pages/BookingPass';
import BookingStatus from './pages/BookingStatus';
import DoctorPage from './pages/DoctorPage';
import Home from './pages/Home';
import MyBookings from './pages/MyBookings';
import Payments from './pages/Payments';
import Profile from './pages/Profile';
import ProfileSummary from './pages/ProfileSummary';
import Records from './pages/Records';
import RecordsCategory from './pages/RecordsCategory';
import RescheduleBooking from './pages/RescheduleBooking';
import Search from './pages/Search';

// The whole patient app - one download, loaded only for patients (App.tsx
// lazy-loads this file), so moving between its pages never waits on the network.
export default function PatientApp() {
  return (
    <PatientOnboardingGate>
      <PatientDeclarationGate>
        <PatientShell>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/search" element={<Search />} />
            <Route path="/doctors/:doctorId" element={<DoctorPage />} />
            <Route path="/bookings" element={<MyBookings />} />
            <Route path="/bookings/:appointmentId" element={<BookingStatus />} />
            <Route path="/bookings/:appointmentId/pass" element={<BookingPass />} />
            <Route path="/bookings/:appointmentId/reschedule" element={<RescheduleBooking />} />
            <Route path="/records" element={<Records />} />
            <Route path="/records/:category" element={<RecordsCategory />} />
            <Route path="/payments" element={<Payments />} />
            {/* Kept so old links/bookmarks to the timeline still land somewhere. */}
            <Route path="/timeline" element={<Records />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/profile/summary" element={<ProfileSummary />} />
            {/* Role-aware guard's other half: a patient account typing a
                clinic/admin-only URL (/admin, /board, /poster, or anything
                else that isn't one of this role's own routes above) lands
                here instead of a blank content area, and is sent to their
                own home - never a broken/empty page. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </PatientShell>
      </PatientDeclarationGate>
    </PatientOnboardingGate>
  );
}
