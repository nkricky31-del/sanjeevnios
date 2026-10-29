import { Activity, useState, type ReactNode } from 'react';

// A console tab that stays alive once it has been opened. Switching away
// hides it and pauses its effects (polling, live updates); switching back
// shows it at once, exactly as it was, while its effects run again and
// refresh what it shows. A tab nobody has opened isn't built at all.
export default function KeepTab({ active, children }: { active: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(active);
  // Remember the first time this tab is shown (React's "adjust state while
  // rendering" pattern - no extra render pass through an effect).
  if (active && !opened) setOpened(true);
  if (!opened && !active) return null;
  return <Activity mode={active ? 'visible' : 'hidden'}>{children}</Activity>;
}
