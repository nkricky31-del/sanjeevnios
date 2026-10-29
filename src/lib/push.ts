import { useSyncExternalStore } from 'react';

import { isNativeApp, nativePlatform } from './native';
import { supabase } from './supabaseClient';

// Alerts on the patient's phone ("push notifications"), even with the app
// closed. How it fits together:
// docs/superpowers/specs/2026-10-30-push-notifications-design.md.
//
// The database writes every alert to the notification list (the bell) and
// hands the patient's ones to the send-push function, which sends them
// through Firebase to each phone the patient turned alerts on for
// (migration 93). This side of it:
//   - asks the phone's permission, gets its Firebase address (token) and
//     registers it (register_push_device); again whenever Firebase replaces
//     the token, and on each start while signed in;
//   - the Profile switch "Alerts on this phone" (set_push_enabled);
//   - Sign out stops this phone's alerts first (forgetThisPhone);
//   - tapping an alert opens its booking; an alert that arrives while the app
//     is open shows as a banner inside it (PushBanner).
//
// Only the Android app offers alerts for now, and only a build that includes
// Firebase's config (android/app/google-services.json). The iPhone app joins
// once it has Firebase's iPhone setup and Apple's push key. The website never
// loads any of this.

const PLATFORMS: readonly string[] = ['android'];
const pushPlatform = isNativeApp && PLATFORMS.includes(nativePlatform);

// This phone's own memory (it survives sign-out; deleting the app clears it):
const TOKEN_KEY = 'sanjeevni.push.token'; //   the token registered for the signed-in account
const WANTED_KEY = 'sanjeevni.push.wanted'; // the patient turned alerts on here (and hasn't turned them off)
const ASKED_KEY = 'sanjeevni.push.asked'; //   the booking screen's card was answered

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode: nothing to remember
  }
}

// ---------------------------------------------------------------------------
// The plugins. Capacitor's plugin objects answer to any property, `then`
// included, so they are kept in variables and never handed through a promise
// (a promise would take one for a pending value and wait on it forever).
// ---------------------------------------------------------------------------

type Messaging = (typeof import('@capacitor-firebase/messaging'))['FirebaseMessaging'];
interface AppSetupPlugin {
  pushStatus(): Promise<{ configured: boolean; systemEnabled: boolean }>;
}

let appSetup: AppSetupPlugin | null = null;
let messaging: Messaging | null = null;
let loading: Promise<boolean> | null = null;

/** The phone's alert settings (android/.../AppSetupPlugin.java). */
async function pushStatus(): Promise<{ configured: boolean; systemEnabled: boolean }> {
  if (!appSetup) {
    const { registerPlugin } = await import('@capacitor/core');
    appSetup = registerPlugin<AppSetupPlugin>('AppSetup');
  }
  return appSetup.pushStatus();
}

/** Loads the Firebase plugin; false where alerts can't be offered. */
function loadMessaging(): Promise<boolean> {
  if (!pushPlatform) return Promise.resolve(false);
  loading ??= (async () => {
    try {
      if (!(await pushStatus()).configured) return false;
      messaging = (await import('@capacitor-firebase/messaging')).FirebaseMessaging;
      return true;
    } catch {
      return false;
    }
  })();
  return loading;
}

// ---------------------------------------------------------------------------
// State, for the card, the Profile switch and the sign-out helper
// ---------------------------------------------------------------------------

export interface PushState {
  /** Alerts can be offered on this phone. */
  available: boolean;
  /** The phone's permission: not given yet, refused (only the phone's
      settings can change it now), or given. */
  permission: 'prompt' | 'denied' | 'granted';
  /** This phone gets this account's alerts. */
  on: boolean;
  /** The booking screen's card has been answered on this phone. */
  asked: boolean;
}

let state: PushState = { available: false, permission: 'prompt', on: false, asked: read(ASKED_KEY) === '1' };
const listeners = new Set<() => void>();
function update(patch: Partial<PushState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function usePushState(): PushState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

async function readPermission(): Promise<PushState['permission']> {
  if (!messaging) return 'prompt';
  try {
    const { receive } = await messaging.checkPermissions();
    if (receive === 'granted') return (await pushStatus()).systemEnabled ? 'granted' : 'denied';
    return receive === 'denied' ? 'denied' : 'prompt';
  } catch {
    return 'prompt';
  }
}

/** Reads it all again (on start, sign-in, and coming back to the app). */
export async function refreshPushState(): Promise<void> {
  if (!(await loadMessaging())) {
    update({ available: false, on: false });
    return;
  }
  const permission = await readPermission();
  let on = false;
  const token = read(TOKEN_KEY);
  if (permission === 'granted' && token) {
    const { data } = await supabase.from('push_devices').select('enabled').eq('token', token).maybeSingle();
    on = !!data?.enabled;
  }
  update({ available: true, permission, on });
}

// Android groups alerts into channels the patient can tune in the phone's
// settings. The ids are the ones send-push names (supabase/functions/send-push).
let channelsMade = false;
async function makeChannels(): Promise<void> {
  if (channelsMade || !messaging || nativePlatform !== 'android') return;
  channelsMade = true;
  try {
    await messaging.createChannel({
      id: 'queue',
      name: 'Queue updates',
      description: 'When your turn is near, and when you are called in',
      importance: 4, // high: sound, and shown at the top of the screen
      visibility: 0, // the phone's own lock-screen setting decides
      vibration: true,
      lights: true,
      lightColor: '#3B5BDB',
    });
    await messaging.createChannel({
      id: 'general',
      name: 'Bookings and reminders',
      description: 'Confirmations, changes to your bookings, and reminders to set off',
      importance: 3,
      visibility: 0,
    });
  } catch {
    channelsMade = false;
  }
}

/** Gets this phone's token and registers it for the signed-in account. */
async function register(enabled?: boolean): Promise<boolean> {
  if (!messaging) return false;
  const { token } = await messaging.getToken();
  if (!token) return false;
  const previous = read(TOKEN_KEY);
  if (previous && previous !== token) {
    // Firebase replaced the token: the old one is no use any more.
    await supabase.rpc('unregister_push_device', { p_token: previous });
  }
  const { error } = await supabase.rpc('register_push_device', {
    p_token: token,
    p_platform: nativePlatform,
    ...(enabled === undefined ? {} : { p_enabled: enabled }),
  });
  if (error) return false;
  write(TOKEN_KEY, token);
  return true;
}

// ---------------------------------------------------------------------------
// What the screens call
// ---------------------------------------------------------------------------

/** "Turn on" (the booking screen's card, or the Profile switch): the phone's
    own permission prompt, then this phone is registered, switched on. */
export async function turnOnAlerts(): Promise<'on' | 'denied' | 'failed'> {
  write(ASKED_KEY, '1');
  update({ asked: true });
  if (!(await loadMessaging()) || !messaging) return 'failed';
  try {
    const { receive } = await messaging.requestPermissions();
    if (receive !== 'granted' || !(await pushStatus()).systemEnabled) {
      update({ permission: receive === 'prompt' || receive === 'prompt-with-rationale' ? 'prompt' : 'denied' });
      return 'denied';
    }
    await makeChannels();
    if (!(await register(true))) return 'failed';
    write(WANTED_KEY, '1');
    update({ permission: 'granted', on: true });
    return 'on';
  } catch {
    return 'failed';
  }
}

/** The Profile switch, off: this phone stops getting this account's alerts. */
export async function turnOffAlerts(): Promise<boolean> {
  const token = read(TOKEN_KEY);
  if (token) {
    const { error } = await supabase.rpc('set_push_enabled', { p_token: token, p_enabled: false });
    if (error) return false;
  }
  write(WANTED_KEY, null);
  update({ on: false });
  return true;
}

/** "Not now" on the booking screen's card. */
export function dismissAlertsCard(): void {
  write(ASKED_KEY, '1');
  update({ asked: true });
}

/** On each start and sign-in: a phone where the patient turned alerts on
    registers for whoever is signed in now (with the token Firebase has for it
    today), and the switch shows the truth. */
let syncing: Promise<void> | null = null;
export function syncPush(): Promise<void> {
  if (!pushPlatform) return Promise.resolve();
  syncing ??= (async () => {
    try {
      if (!(await loadMessaging())) return;
      await makeChannels();
      const { data } = await supabase.auth.getSession();
      if (!data.session) return;
      if (read(WANTED_KEY) === '1' && (await readPermission()) === 'granted') await register();
      await refreshPushState();
    } catch {
      // alerts are a convenience: never in the way of the app
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/** Sign out (every Sign out button, lib/signOut.ts): this phone stops getting
    the account's alerts. Never waits more than a few seconds, and never
    fails - signing out goes ahead either way. */
export async function forgetThisPhone(): Promise<void> {
  const token = read(TOKEN_KEY);
  if (!token) return;
  write(TOKEN_KEY, null);
  update({ on: false });
  await Promise.race([
    supabase
      .rpc('unregister_push_device', { p_token: token })
      .then(() => undefined, () => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, 3000)),
  ]);
}

// ---------------------------------------------------------------------------
// Alerts arriving
// ---------------------------------------------------------------------------

/** An alert that arrived while the app was open. */
export interface InAppAlert {
  key: string;
  title: string;
  body: string;
  route: string | null;
  appointmentId: string | null;
}

/** Fired on window for every alert that arrives while the app is open, so an
    open screen (the booking, the bell) can look again at once. */
export const ALERT_EVENT = 'sanjeevni:alert';

// Only these: an alert opens a booking or the notification list, nothing else.
function routeOf(data: unknown): string | null {
  const route = (data as { route?: unknown } | null)?.route;
  if (typeof route !== 'string') return null;
  return /^\/bookings\/[0-9a-f-]{36}$/i.test(route) || route === '/notifications' ? route : null;
}

const alertListeners = new Set<(alert: InAppAlert) => void>();
/** PushBanner listens here. */
export function onInAppAlert(listener: (alert: InAppAlert) => void): () => void {
  alertListeners.add(listener);
  return () => alertListeners.delete(listener);
}

function arrived(notification: { id?: string; title?: string; body?: string; data?: unknown }): void {
  const data = (notification.data ?? {}) as Record<string, unknown>;
  const appointmentId = typeof data.appointment_id === 'string' ? data.appointment_id : null;
  window.dispatchEvent(new CustomEvent(ALERT_EVENT, { detail: { appointmentId } }));
  if (!notification.body) return;
  const alert: InAppAlert = {
    key: notification.id ?? `${Date.now()}`,
    title: notification.title || 'SanjeevniOS',
    body: notification.body,
    route: routeOf(data),
    appointmentId,
  };
  for (const listener of alertListeners) listener(alert);
}

/** NativeAppBridge, once: a tapped alert opens its screen (also when the tap
    started the app), an alert arriving in the open app shows inside it, and a
    new token is registered. Returns the clean-up. */
export function startPushListeners(open: (route: string) => void): () => void {
  let stopped = false;
  const handles: Array<{ remove: () => Promise<void> }> = [];
  void loadMessaging().then(async (ok) => {
    if (!ok || !messaging || stopped) return;
    const keep = (handle: { remove: () => Promise<void> }) => {
      if (stopped) void handle.remove();
      else handles.push(handle);
    };
    keep(
      await messaging.addListener('notificationActionPerformed', (event) => {
        const route = routeOf(event.notification?.data);
        if (route) open(route);
      }),
    );
    keep(await messaging.addListener('notificationReceived', (event) => arrived(event.notification ?? {})));
    keep(await messaging.addListener('tokenReceived', () => void syncPush()));
  });
  return () => {
    stopped = true;
    for (const handle of handles) void handle.remove();
  };
}
