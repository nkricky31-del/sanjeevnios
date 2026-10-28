import { useCallback, useEffect, useRef } from 'react';

import { supabase } from './supabaseClient';

const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

// A repeating refresh that only runs while the screen is actually on show.
// A phone in a pocket or a tab in the background asks the server nothing;
// when it comes back and a tick is overdue, it refreshes straight away
// (pass catchUp = false where the screen already reloads on return).
export function useVisibleInterval(callback: () => void, intervalMs: number, enabled = true, catchUp = true): void {
  const fn = useRef(callback);
  useEffect(() => {
    fn.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    const tick = () => {
      if (!isVisible()) return;
      last = Date.now();
      fn.current();
    };
    const timer = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (!isVisible()) return;
      if (catchUp && Date.now() - last >= intervalMs) tick();
      else last = Date.now();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, enabled, catchUp]);
}

// For "something changed - reload" signals from a live queue channel. Every
// screen watching that queue gets the same signal at the same instant, and
// one action often sends several (calling the next patient changes two
// bookings), so:
//   - signals that arrive close together become ONE reload,
//   - each device waits a short random moment first, spreading a busy
//     queue's reloads over about a second instead of all at once,
//   - a hidden screen just remembers it is out of date and reloads when it
//     is shown again.
// Returns a stable function to call from the channel handler.
export function useCoalescedRefresh(refresh: () => void, delayMs = 250, jitterMs = 1000): () => void {
  const fn = useRef(refresh);
  const timer = useRef<number | null>(null);
  const stale = useRef(false);
  useEffect(() => {
    fn.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (isVisible() && stale.current) {
        stale.current = false;
        fn.current();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  return useCallback(() => {
    if (!isVisible()) {
      stale.current = true;
      return;
    }
    if (timer.current != null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      fn.current();
    }, delayMs + Math.random() * jitterMs);
  }, [delayMs, jitterMs]);
}

// The id of whoever is signed in on this device, read locally. Unlike
// supabase.auth.getUser() it does not ask the auth server - row access is
// enforced by the database anyway, so this is only used to fill in user_id.
export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}
