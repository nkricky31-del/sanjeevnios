import { lazy, type ComponentType } from 'react';

const RELOAD_KEY = 'sn_chunk_reload';

// A section of the app downloaded only when it's first needed (code
// splitting), so a patient never downloads the admin or clinic consoles.
//
// After a deploy, a tab that was opened before it still asks for the OLD file
// names, which the host no longer serves. That shows up as a failed import:
// reload once to pick up the new version (guarded so it can't loop).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().then(
      (mod) => {
        try {
          sessionStorage.removeItem(RELOAD_KEY);
        } catch {
          // ignore
        }
        return mod;
      },
      (err) => {
        // Offline, a reload would only swap the app for the browser's own
        // "no internet" page - let the error screen say so instead.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw err;
        let reloaded = false;
        try {
          reloaded = sessionStorage.getItem(RELOAD_KEY) === '1';
          if (!reloaded) sessionStorage.setItem(RELOAD_KEY, '1');
        } catch {
          reloaded = true; // no storage: don't risk a reload loop
        }
        if (!reloaded) {
          window.location.reload();
          return new Promise<{ default: T }>(() => {}); // the reload takes over
        }
        throw err;
      }
    )
  );
}
