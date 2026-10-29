import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { canGoBack } from '../lib/history';
import { hideSplashScreen, isNativeApp, nativePlatform } from '../lib/native';
import { refreshPushState, startPushListeners, syncPush } from '../lib/push';
import { supabase } from '../lib/supabaseClient';

// App-only behaviour that needs the router (renders nothing; does nothing on
// the website):
// - the launch screen is hidden once the first screen has been drawn;
// - Android's back button (and back gesture) closes an open menu or sheet,
//   otherwise goes back a screen, otherwise home, and on the home screen
//   sends the app to the background - what Android users expect;
// - alerts (lib/push.ts): a tapped alert opens its booking, even when the tap
//   started the app; on sign-in and on each start the phone is registered
//   for whoever is signed in, and on coming back to the app the alert
//   settings are read again (they may have changed in the phone's settings).
export default function NativeAppBridge() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const path = useRef(pathname);
  useEffect(() => {
    path.current = pathname;
  }, [pathname]);
  // navigate can change on every screen change; the alert listeners below are
  // set up once per start and reach it through this.
  const go = useRef(navigate);
  useEffect(() => {
    go.current = navigate;
  }, [navigate]);

  useEffect(() => {
    hideSplashScreen();
  }, []);

  useEffect(() => {
    if (!isNativeApp) return;
    const stopListening = startPushListeners((route) => go.current(route));
    // Not inside the callback itself: supabase-js asks that its own calls wait
    // until the callback has returned.
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') window.setTimeout(() => void syncPush(), 0);
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshPushState();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopListening();
      data.subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!isNativeApp || nativePlatform !== 'android') return;
    let cancelled = false;
    let handle: { remove: () => Promise<void> } | undefined;
    void import('@capacitor/app').then(({ App }) =>
      App.addListener('backButton', () => {
        // An open menu or sheet closes first - each one closes on Escape.
        if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) {
          (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return;
        }
        if (canGoBack()) navigate(-1);
        else if (path.current !== '/') navigate('/', { replace: true });
        else void App.minimizeApp();
      }).then((h) => {
        if (cancelled) void h.remove();
        else handle = h;
      }),
    );
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [navigate]);

  return null;
}
