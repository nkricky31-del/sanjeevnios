import { Clock } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { clearIdleSignOut, IDLE_LIMIT_MINUTES, readIdleSignOut } from '../../lib/idleTimeout';
import { AuthNotice } from './AuthFields';

// On a login screen reached because the last session was signed out for
// inactivity (lib/idleTimeout.ts), says so - once. Otherwise shows `fallback`.
export default function IdleSignedOutNotice({ fallback = null }: { fallback?: ReactNode }) {
  const [role] = useState(readIdleSignOut);
  useEffect(() => {
    if (role) clearIdleSignOut();
  }, [role]);
  if (!role) return <>{fallback}</>;
  return (
    <AuthNotice icon={Clock}>
      For your security, you were signed out after {IDLE_LIMIT_MINUTES[role]} minutes without activity. Please
      sign in again.
    </AuthNotice>
  );
}
