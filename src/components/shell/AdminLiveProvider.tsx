import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ADMIN_AREAS, AdminLiveContext, type AdminArea, type AdminLiveState } from '../../lib/adminLive';
import { useVisibleInterval } from '../../lib/livePolling';
import { supabase } from '../../lib/supabaseClient';

const REFRESH_EVERY_MS = 60_000;
// Signals that arrive close together (approving a clinic touches the clinic,
// its doctors and documents) become one refresh.
const GATHER_MS = 1000;

// Listens on "admin:events" (migration 90 - only admins may join) for the
// whole admin console, and ticks once a minute while it is on screen. See
// lib/adminLive.ts for how screens use it.
export default function AdminLiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AdminLiveState>({ versions: {}, tick: 0 });
  const pending = useRef(new Set<AdminArea>());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const flush = () => {
      timer.current = null;
      const areas = [...pending.current];
      pending.current.clear();
      setState((s) => {
        const versions = { ...s.versions };
        for (const a of areas) versions[a] = (versions[a] ?? 0) + 1;
        return { ...s, versions };
      });
    };
    const onSignal = (area: AdminArea) => () => {
      pending.current.add(area);
      if (timer.current == null) timer.current = window.setTimeout(flush, GATHER_MS);
    };

    supabase.realtime.setAuth();
    const channel = supabase.channel('admin:events', { config: { private: true } });
    for (const area of ADMIN_AREAS) channel.on('broadcast', { event: area }, onSignal(area));
    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  useVisibleInterval(() => setState((s) => ({ ...s, tick: s.tick + 1 })), REFRESH_EVERY_MS);

  return <AdminLiveContext.Provider value={state}>{children}</AdminLiveContext.Provider>;
}
