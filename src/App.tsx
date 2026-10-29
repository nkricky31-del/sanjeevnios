import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import IdleGuard from './components/IdleGuard';
import Button from './components/ui/Button';
import { InstallBanner, OfflineBanner } from './components/InstallBanner';
import SplashLoader from './components/ui/SplashLoader';
import { getStoredActingMode } from './lib/actingMode';
import { isStandalone } from './lib/pwa';
import { usePressFx } from './lib/pressFx';
import { useAuth } from './lib/AuthContext';
import { CLINIC_SIGNUP_INTENT_KEY } from './lib/clinicSignupIntent';
import { idleRoleFor, LOGIN_PATH, readIdleSignOut } from './lib/idleTimeout';
import { lazyPage } from './lib/lazyPage';
import {
  loadAdminConsole, loadAdminLogin, loadClinicLogin, loadClinicPoster, loadClinicQueue, loadClinicSignup, loadEncounterDetail,
  loadMarketingSite, loadNotificationsList, loadPatientApp, loadPatientLogin, loadTokenBoard, prefetchFor,
} from './lib/sections';
import { supabase } from './lib/supabaseClient';

// Each part of the app is downloaded only when it's used (lib/lazyPage.ts):
// visitors get the website, patients the patient app, clinics their console.
const MarketingSite = lazyPage(loadMarketingSite);
const PatientLogin = lazyPage(loadPatientLogin);
const ClinicLogin = lazyPage(loadClinicLogin);
const AdminLogin = lazyPage(loadAdminLogin);
const PatientApp = lazyPage(loadPatientApp);
const ClinicQueue = lazyPage(loadClinicQueue);
const ClinicSignup = lazyPage(loadClinicSignup);
const ClinicPoster = lazyPage(loadClinicPoster);
const TokenBoard = lazyPage(loadTokenBoard);
const AdminConsole = lazyPage(loadAdminConsole);
const EncounterDetail = lazyPage(loadEncounterDetail);
const NotificationsList = lazyPage(loadNotificationsList);
import AdminMfaGate from './components/AdminMfaGate';
import PatientShell from './components/shell/PatientShell';

function AppContent() {
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

  // Once we know who this is, quietly download the parts of the app they can
  // open (lib/sections.ts), so moving around doesn't wait on downloads.
  const role = profile?.role;
  useEffect(() => {
    if (!role) return;
    const mode = role === 'admin' ? 'admin' : (getStoredActingMode() ?? (role === 'clinic' ? 'clinic' : 'patient'));
    prefetchFor(mode === 'admin' ? 'admin' : mode === 'clinic' ? 'clinic' : 'patient');
  }, [role]);

  if (loading) return <SplashLoader />;

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
    // Just signed out for inactivity (lib/idleTimeout.ts): straight to that
    // person's own login screen - clinic, admin or patient - which explains
    // why, rather than the public website or the patient login.
    const idleRole = readIdleSignOut();
    if (idleRole && !Object.values(LOGIN_PATH).includes(location.pathname)) {
      const here = location.pathname + location.search;
      const next = location.pathname !== '/' ? `?next=${encodeURIComponent(here)}` : '';
      return <Navigate to={LOGIN_PATH[idleRole] + next} replace />;
    }
    // The installed app opens straight to sign-in; the marketing page is for browsers.
    if (location.pathname === '/' && isStandalone()) return <Navigate to="/login" replace />;
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
  // These two screens are reachable by every role. A patient gets the normal
  // sidebar/tab-bar frame around them; clinic and admin keep the plain page.
  const framed = (node: ReactNode) =>
    (profile.role !== 'admin' && (getStoredActingMode() ?? (profile.role === 'clinic' ? 'clinic' : 'patient')) === 'patient') ? (
      <PatientShell>{node}</PatientShell>
    ) : (
      <div className="min-h-screen bg-canvas">{node}</div>
    );

  const encounterMatch = location.pathname.match(/^\/encounters\/([^/]+)$/);
  if (encounterMatch) {
    return framed(<EncounterDetail encounterId={encounterMatch[1]} />);
  }

  // Same idea as the encounter route above - reachable by any role via the
  // bell icon on every AppHeader (see useUnreadNotifications.ts), regardless
  // of which role-specific screen they're currently on.
  if (location.pathname === '/notifications') {
    return framed(<NotificationsList />);
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
        <AdminMfaGate>
          <AdminConsole />
        </AdminMfaGate>
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

  return <PatientApp />;
}

// Everything after sign-in lives inside the app scope (index.css `.app-scope`),
// with the accent chosen by role. The printable self-check-in poster stays
// outside it so it prints exactly as designed.
export default function App() {
  const { session, profile } = useAuth();
  const location = useLocation();
  usePressFx();
  useDarkBackdropWhen(Boolean(session && profile) && location.pathname !== '/poster');

  const banners = (
    <>
      <OfflineBanner />
      <InstallBanner />
    </>
  );
  // Signs a session out after a period without use (lib/idleTimeout.ts).
  const idleGuard = session && profile ? <IdleGuard role={idleRoleFor(profile.role, getStoredActingMode())} /> : null;
  if (!session || !profile || location.pathname === '/poster') {
    return (
      <>
        <Suspense fallback={<SplashLoader />}>
          <AppContent />
        </Suspense>
        {banners}
        {idleGuard}
      </>
    );
  }
  const role = profile.role === 'admin' ? 'admin' : (getStoredActingMode() ?? (profile.role === 'clinic' ? 'clinic' : 'patient'));
  return (
    <div className="app-scope min-h-screen" data-app-role={role}>
      <Suspense fallback={<SplashLoader />}>
        <AppContent />
      </Suspense>
      {banners}
      {idleGuard}
    </div>
  );
}

function useDarkBackdropWhen(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    const previous = root.style.backgroundColor;
    root.style.backgroundColor = '#fafbfc';
    return () => {
      root.style.backgroundColor = previous;
    };
  }, [on]);
}
