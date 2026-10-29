// The separately-downloaded parts of the app (see lazyPage.ts), in one place
// so App.tsx and prefetchFor() load exactly the same files.
export const loadMarketingSite = () => import('../marketing/MarketingSite');
export const loadPatientLogin = () => import('../pages/PatientLogin');
export const loadClinicLogin = () => import('../pages/ClinicLogin');
export const loadAdminLogin = () => import('../pages/AdminLogin');
export const loadPatientApp = () => import('../PatientApp');
export const loadClinicQueue = () => import('../pages/ClinicQueue');
export const loadClinicSignup = () => import('../pages/ClinicSignup');
export const loadClinicPoster = () => import('../pages/ClinicPoster');
export const loadTokenBoard = () => import('../pages/TokenBoard');
export const loadAdminConsole = () => import('../pages/AdminConsole');
export const loadEncounterDetail = () => import('../components/EncounterDetail');
export const loadNotificationsList = () => import('../components/NotificationsList');
export const loadLeafletMap = () => import('../components/LeafletMap');

type Loader = () => Promise<unknown>;
const started = new Set<Loader>();

// Downloads the parts someone is about to use while the device is otherwise
// idle, so moving to them later opens at once instead of waiting for a
// download. Each part is fetched once; a failed fetch is simply retried the
// next time (or when the part is actually opened).
export function prefetch(loaders: Loader[]): void {
  const run = () => {
    for (const load of loaders) {
      if (started.has(load)) continue;
      started.add(load);
      load().catch(() => started.delete(load));
    }
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 2500 });
  else window.setTimeout(run, 800);
}

// Everything each kind of user can open from where they are.
export function prefetchFor(role: 'patient' | 'clinic' | 'admin'): void {
  if (role === 'patient') prefetch([loadPatientApp, loadEncounterDetail, loadNotificationsList, loadLeafletMap]);
  else if (role === 'clinic') prefetch([loadClinicQueue, loadEncounterDetail, loadNotificationsList, loadTokenBoard, loadClinicPoster, loadLeafletMap]);
  else prefetch([loadAdminConsole, loadEncounterDetail, loadNotificationsList]);
}
