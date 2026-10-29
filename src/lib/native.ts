import { useEffect, useSyncExternalStore } from 'react';

// The Android and iPhone apps are this same web app running inside Capacitor
// (capacitor.config.ts). The few things that must work differently inside
// the app go through here: files, printing, links, location, the status bar
// and the splash screen. On the website each helper does exactly what the
// app always did.
//
// Capacitor's native layer sets window.Capacitor before any of our code runs,
// so telling app from website needs nothing loaded. The plugins are imported
// on demand, only inside the app; the website never downloads them.

type CapacitorGlobal = { isNativePlatform?: () => boolean; getPlatform?: () => string };
const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;

export const isNativeApp: boolean = Boolean(cap?.isNativePlatform?.());
export const nativePlatform = (isNativeApp ? cap?.getPlatform?.() ?? 'web' : 'web') as 'ios' | 'android' | 'web';

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

/** Called once from main.tsx. Marks the page as the app (for CSS) and shows
    the right status bar text from the first frame. */
export function startNativeApp(): void {
  if (!isNativeApp) return;
  document.documentElement.classList.add('native-app', `native-${nativePlatform}`);
  syncStatusBar();
}

/** The launch screen stays up (launchAutoHide: false) until the app has drawn
    its first frame; it then fades into the same leaf on the same background. */
export function hideSplashScreen(): void {
  if (!isNativeApp) return;
  requestAnimationFrame(() => {
    void import('@capacitor/splash-screen').then(({ SplashScreen }) => SplashScreen.hide()).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Status bar text colour
// ---------------------------------------------------------------------------
// Every screen opens with a coloured header that runs up behind the status
// bar, so the bar's clock and icons are drawn in white over it. A white sheet
// laid over the screen (a prescription, a patient's details) asks for dark
// text while it's open. The most recently shown one wins; with none showing
// (the loading screen) the text is dark.

type StatusBarText = 'light' | 'dark';
const statusBarRequests: Array<{ text: StatusBarText }> = [];
let statusBarTimer: number | undefined;

/** How far the status bar reaches into the page (0 when the page starts below
    it: the website, or an old Android web view). */
export function safeAreaTop(): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h;
}

function syncStatusBar(): void {
  if (!isNativeApp) return;
  window.clearTimeout(statusBarTimer);
  // Gathered: leaving one screen and opening the next makes one change.
  statusBarTimer = window.setTimeout(() => {
    const want = statusBarRequests[statusBarRequests.length - 1]?.text ?? 'dark';
    // White text only where a header really sits behind the bar.
    const light = want === 'light' && safeAreaTop() > 0;
    void import('@capacitor/core')
      .then(({ SystemBars, SystemBarsStyle, SystemBarType }) =>
        SystemBars.setStyle({ style: light ? SystemBarsStyle.Dark : SystemBarsStyle.Light, bar: SystemBarType.StatusBar }),
      )
      .catch(() => {});
  }, 30);
}

// Tailwind's `lg`: the laptop layout (sidebar, header as a card with a
// margin). An iPad held sideways or a wide Android tablet gets it too; there
// the status bar sits over a plain strip of the page's colour (index.css,
// html.native-app) and keeps dark text.
const WIDE = '(min-width: 1024px)';
function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
export function useWideLayout(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);
}

/** For a coloured header at the very top of a phone screen: white status bar
    text while it shows (not in the wide layout, where it isn't at the top). */
export function useHeaderStatusBar(): void {
  useStatusBarText('light', !useWideLayout());
}

/** While the calling component is on screen, the status bar's text is drawn
    `text` ('light' over a dark header, 'dark' over a white sheet). Does
    nothing on the website. */
export function useStatusBarText(text: StatusBarText, active = true): void {
  useEffect(() => {
    if (!isNativeApp || !active) return;
    const request = { text };
    statusBarRequests.push(request);
    syncStatusBar();
    return () => {
      const i = statusBarRequests.indexOf(request);
      if (i >= 0) statusBarRequests.splice(i, 1);
      syncStatusBar();
    };
  }, [text, active]);
}

// Screens whose header stays pinned behind the status bar (ScreenHeader) need
// no backdrop there; the others (a HeroBand scrolls away with the page) get
// one once the page scrolls: components/StatusBarBackdrop.tsx.
let pinnedHeaders = 0;
const pinnedListeners = new Set<() => void>();
function pinnedChanged(): void {
  for (const listener of pinnedListeners) listener();
}
export function usePinnedHeader(): void {
  useEffect(() => {
    if (!isNativeApp) return;
    pinnedHeaders += 1;
    pinnedChanged();
    return () => {
      pinnedHeaders -= 1;
      pinnedChanged();
    };
  }, []);
}
function subscribePinned(onChange: () => void): () => void {
  pinnedListeners.add(onChange);
  return () => pinnedListeners.delete(onChange);
}
export function useHasPinnedHeader(): boolean {
  return useSyncExternalStore(subscribePinned, () => pinnedHeaders > 0, () => false);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(blob);
  });
}

/** Saves a file the person asked for (a bill, a statement, an export). The
    website downloads it; the app has no downloads folder to drop it into, so
    it opens the phone's share sheet instead - Save to Files, Drive, WhatsApp,
    email, print. */
export async function saveFile(data: Blob | Uint8Array | string, name: string, type: string): Promise<void> {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  if (!isNativeApp) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  const fileName = name.replace(/[\\/:*?"<>|]+/g, '-');
  const { uri } = await Filesystem.writeFile({
    path: `exports/${fileName}`,
    data: await toBase64(blob),
    directory: Directory.Cache,
    recursive: true,
  });
  try {
    await Share.share({ title: fileName, files: [uri] });
  } catch (e) {
    // Closing the share sheet without picking anything isn't an error.
    if (!/cancel/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
}

/** Opens a web page or file (a signed link to a report, a document) outside
    the app's own screens: a new tab on the website, an in-app browser sheet in
    the app, which the person closes to come straight back. */
export function openExternal(url: string): void {
  if (!isNativeApp) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  void import('@capacitor/browser')
    .then(({ Browser }) => Browser.open({ url }))
    .catch(() => window.open(url, '_blank'));
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

interface PrinterPlugin {
  printPage(options: { name: string }): Promise<void>;
}
// Kept as a plain value, never resolved through a promise: a Capacitor plugin
// answers every property, `then` included, so a promise would mistake it for
// another promise and call a native "then" that doesn't exist.
let printer: PrinterPlugin | null = null;

/** Prints what's on screen, with the page's print styles. A web view can't
    open the print dialog by itself, so the app asks its own Printer plugin
    (android/.../PrinterPlugin.java, ios/App/App/PrinterPlugin.swift). */
export async function printPage(name = 'SanjeevniOS'): Promise<void> {
  if (!isNativeApp) {
    window.print();
    return;
  }
  if (!printer) {
    const { registerPlugin } = await import('@capacitor/core');
    printer = registerPlugin<PrinterPlugin>('Printer');
  }
  await printer.printPage({ name });
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/** Can this device report where it is? */
export function canGetPosition(): boolean {
  return isNativeApp || 'geolocation' in navigator;
}

/** navigator.geolocation.getCurrentPosition, the same callbacks and error
    codes. Inside the app it goes through the Geolocation plugin, which asks
    for the phone's location permission properly (an iPhone web view would
    otherwise ask a second, confusing "localhost wants your location"). */
export function getCurrentPosition(
  onSuccess: (position: { coords: { latitude: number; longitude: number; accuracy: number } }) => void,
  onError?: (error: { code: number; message: string }) => void,
  options?: PositionOptions,
): void {
  if (!isNativeApp) {
    navigator.geolocation.getCurrentPosition(onSuccess, onError, options);
    return;
  }
  void import('@capacitor/geolocation')
    .then(({ Geolocation }) =>
      Geolocation.getCurrentPosition({
        enableHighAccuracy: options?.enableHighAccuracy ?? false,
        timeout: options?.timeout ?? 15_000,
        maximumAge: options?.maximumAge ?? 0,
      }),
    )
    .then((p) => onSuccess({ coords: { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy } }))
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      // The web's codes: 1 permission denied, 2 position unavailable, 3 timeout.
      const code = /denied|permission|not authorized/i.test(message) ? 1 : /time ?out/i.test(message) ? 3 : 2;
      onError?.({ code, message });
    });
}
