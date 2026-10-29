import type { CapacitorConfig } from '@capacitor/cli';

// The Android and iPhone apps: the same web app (the `dist` build) running
// inside Capacitor. `npm run cap:sync` rebuilds it and copies it into the
// native projects in /android and /ios.
const config: CapacitorConfig = {
  // The apps' permanent identity on Google Play and the App Store - it can
  // never change once the first version is published.
  appId: 'in.sanjeevnios.app',
  appName: 'SanjeevniOS',
  webDir: 'dist',
  // Behind the web view while it starts: the app's canvas colour.
  backgroundColor: '#fafbfc',
  ios: {
    // The web content runs edge to edge; headers pad themselves with
    // env(safe-area-inset-top) (see lib/native.ts).
    contentInset: 'never',
    // Every plugin except alerts (@capacitor-firebase/messaging): the iPhone
    // app gets alerts in a later step, with Firebase's iPhone setup and
    // Apple's push key (docs/superpowers/specs/2026-10-30-push-notifications-design.md).
    // Until then lib/push.ts doesn't offer them there.
    includePlugins: [
      '@capacitor/app',
      '@capacitor/browser',
      '@capacitor/filesystem',
      '@capacitor/geolocation',
      '@capacitor/share',
      '@capacitor/splash-screen',
    ],
  },
  plugins: {
    SplashScreen: {
      // Stays up until the app has drawn its first screen (lib/native.ts).
      launchAutoHide: false,
      launchFadeOutDuration: 250,
      backgroundColor: '#fafbfc',
      showSpinner: false,
    },
    SystemBars: {
      // Edge to edge on Android too (index.html has viewport-fit=cover):
      // env(safe-area-inset-*) holds the real status/navigation bar sizes.
      insetsHandling: 'native',
      initialViewportFitValueHint: 'cover',
      // Dark status bar text for the light screens; screens with a dark
      // header switch it to light while they're showing.
      style: 'LIGHT',
    },
  },
};

export default config;
