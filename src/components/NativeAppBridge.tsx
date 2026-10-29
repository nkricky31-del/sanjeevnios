import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { canGoBack } from '../lib/history';
import { hideSplashScreen, isNativeApp, nativePlatform } from '../lib/native';

// App-only behaviour that needs the router (renders nothing; does nothing on
// the website):
// - the launch screen is hidden once the first screen has been drawn;
// - Android's back button (and back gesture) closes an open menu or sheet,
//   otherwise goes back a screen, otherwise home, and on the home screen
//   sends the app to the background - what Android users expect.
export default function NativeAppBridge() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const path = useRef(pathname);
  useEffect(() => {
    path.current = pathname;
  }, [pathname]);

  useEffect(() => {
    hideSplashScreen();
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
