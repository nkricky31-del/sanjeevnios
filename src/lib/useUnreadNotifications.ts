import { useEffect, useState } from 'react';

import { useAuth } from './AuthContext';
import { supabase } from './supabaseClient';

// Powers the bell-dot indicator on every AppHeader across all three roles -
// notifications.user_id = auth.uid() is role-agnostic, so this works
// identically for a patient, a clinic, or admin. Re-fetches on every mount,
// which in practice means "fresh on every page navigation" since each page
// renders its own <AppHeader>.
export function useUnreadNotifications() {
  const { session } = useAuth();
  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    if (!session) return;
    supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.user.id)
      .eq('read', false)
      .then(({ count }) => setHasUnread((count ?? 0) > 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  return hasUnread;
}
