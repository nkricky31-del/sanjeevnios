import { BellRing } from 'lucide-react';
import { useState } from 'react';

import { turnOffAlerts, turnOnAlerts, usePushState } from '../lib/push';
import IconTile from './ui/IconTile';
import Toggle from './ui/Toggle';

// Profile > Account & Preferences: whether this phone gets this account's
// alerts (lib/push.ts). Only in the app, where alerts can work. Refused at the
// phone's prompt, only the phone's settings can allow them again, so the row
// says where.
export default function PhoneAlertsRow({ className = '' }: { className?: string }) {
  const push = usePushState();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!push.available) return null;

  const blocked = push.permission === 'denied';
  const change = async (next: boolean) => {
    setBusy(true);
    setProblem(null);
    if (next) {
      if ((await turnOnAlerts()) === 'failed') {
        setProblem("Alerts couldn't be turned on just now. Check your internet connection and try again.");
      }
    } else if (!(await turnOffAlerts())) {
      setProblem("Alerts couldn't be turned off just now. Please try again.");
    }
    setBusy(false);
  };
  const detail = blocked
    ? 'Blocked in your phone settings. To allow them: Settings > Apps > SanjeevniOS > Notifications.'
    : push.on
      ? 'Your turn in the queue, and booking updates'
      : 'Off on this phone';

  return (
    <div className={`flex items-center gap-3 px-4 py-3.5 ${className}`}>
      <IconTile icon={BellRing} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-slate-900">Alerts on this phone</span>
        <span className={`block text-xs ${problem ? 'text-red-600' : 'text-slate-500'}`}>{problem ?? detail}</span>
      </span>
      <Toggle
        checked={push.on && !blocked}
        onChange={(next) => void change(next)}
        label="Alerts on this phone"
        disabled={busy || blocked}
        onLabel="On"
        offLabel="Off"
      />
    </div>
  );
}
