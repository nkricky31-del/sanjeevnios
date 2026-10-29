import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

// The open console tab lives in the address (/?tab=patients), so the browser's
// back button, a reload, or coming back from a detail screen (an encounter,
// notifications) returns to the same tab - not always the first one. The
// first tab is the bare address. Switching tabs drops the previous tab's own
// details (e.g. the patient open in Patients).
export function useConsoleTab<T extends string>(tabs: readonly T[], first: T): [T, (tab: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab = raw && (tabs as readonly string[]).includes(raw) ? (raw as T) : first;

  const setTab = useCallback(
    (next: T) => {
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        p.delete('mrn');
        if (next === first) p.delete('tab');
        else p.set('tab', next);
        return p;
      });
    },
    [setParams, first]
  );

  return [tab, setTab];
}
