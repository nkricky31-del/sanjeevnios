import { useEffect, useRef } from 'react';

// Re-runs `refresh` when the person comes back to the app (switches back to
// the tab, unlocks the phone, reopens the installed app) - so anything the
// clinic added meanwhile (a prescription, a report) is there without a manual
// reload. At most once every few seconds, since focus and visibility often
// fire together.
export function useRefreshOnReturn(refresh: () => void, minGapMs = 3000): void {
  const fn = useRef(refresh);
  const last = useRef(0);
  useEffect(() => {
    fn.current = refresh;
  }, [refresh]);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last.current < minGapMs) return;
      last.current = now;
      fn.current();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [minGapMs]);
}
