import { useEffect, useState } from 'react';

import { isNativeApp, useHasPinnedHeader } from '../lib/native';

// The phone apps only. A screen's coloured header runs up behind the status
// bar; once the page scrolls and that header has gone up with it, this
// translucent strip in the role's colour fades in behind the status bar so
// its white clock and icons stay readable over the content. Screens with a
// pinned header (ScreenHeader) don't need it. Wide layouts (tablets) use the
// plain strip in index.css instead.
export default function StatusBarBackdrop() {
  const [scrolled, setScrolled] = useState(false);
  const pinned = useHasPinnedHeader();

  useEffect(() => {
    if (!isNativeApp) return;
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!isNativeApp) return null;
  return <div aria-hidden className={`native-status-backdrop${scrolled && !pinned ? ' is-on' : ''}`} />;
}
