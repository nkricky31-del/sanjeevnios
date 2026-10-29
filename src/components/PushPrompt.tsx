import { BellRing } from 'lucide-react';
import { useState } from 'react';

import { dismissAlertsCard, turnOnAlerts, usePushState } from '../lib/push';
import Button from './ui/Button';
import Card from './ui/Card';
import IconTile from './ui/IconTile';

// On the booking screen, once there is a booking or a place in the queue:
// offers alerts on this phone (lib/push.ts). Not at first launch, and not
// again once answered - alerts on, "Not now", or the phone's prompt refused
// (Profile then has the switch, and says how to allow alerts in the phone's
// settings). Only in the app, where alerts can work.
export default function PushPrompt({ className = '' }: { className?: string }) {
  const push = usePushState();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!push.available || push.on || push.asked || push.permission === 'denied') {
    // A failure keeps the card up with its message, until "Not now".
    if (!failed) return null;
  }

  const turnOn = async () => {
    setBusy(true);
    const result = await turnOnAlerts();
    setBusy(false);
    setFailed(result === 'failed');
  };

  return (
    <Card className={`!p-4 ${className}`}>
      <div className="flex items-start gap-3">
        <IconTile icon={BellRing} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-slate-900">Get an alert when your turn is near</p>
          <p className="mt-0.5 text-sm leading-snug text-slate-500">
            {failed
              ? "Alerts couldn't be turned on just now. Check your internet connection and try again."
              : "We'll tell you when one or two people are ahead of you, and when it's your turn, even with the app closed."}
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          variant="ghost"
          className="!px-3 !py-2 !text-sm"
          onClick={() => {
            setFailed(false);
            dismissAlertsCard();
          }}
        >
          Not now
        </Button>
        <Button className="!px-4 !py-2 !text-sm" onClick={turnOn} disabled={busy}>
          {busy ? 'Turning on…' : 'Turn on'}
        </Button>
      </div>
    </Card>
  );
}
