import { useEffect, useState } from 'react';

import { useAuth } from './AuthContext';
import { ALERT_EVENT } from './push';
import { supabase } from './supabaseClient';

// Powers the bell-dot indicator on every AppHeader across all three roles -
// notifications.user_id = auth.uid() is role-agnostic, so this works
// identically for a patient, a clinic, or admin. Re-fetches on every mount,
// which in practice means "fresh on every page navigation" since each page
// renders its own <AppHeader>.
// refreshKey: change it to look again (the admin console passes its live
// update counter - lib/adminLive.ts).
export function useUnreadNotifications(refreshKey = 0) {
  const { session } = useAuth();
  const [hasUnread, setHasUnread] = useState(false);
  // An alert arriving while the app is open (lib/push.ts) is news for the bell too.
  const [arrived, setArrived] = useState(0);
  useEffect(() => {
    const bump = () => setArrived((n) => n + 1);
    window.addEventListener(ALERT_EVENT, bump);
    return () => window.removeEventListener(ALERT_EVENT, bump);
  }, []);

  useEffect(() => {
    if (!session) return;
    supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.user.id)
      .eq('read', false)
      .then(({ count }) => setHasUnread((count ?? 0) > 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id, refreshKey, arrived]);

  return hasUnread;
}
