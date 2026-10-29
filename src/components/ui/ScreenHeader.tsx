import { ArrowLeft, Home } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { canGoBack } from '../../lib/history';

interface Props {
  title: string;
  /** Where the back arrow goes: a path, or -1 for the previous screen (see
      `fallback`). Omit for no back arrow. */
  back?: string | number;
  /** Where -1 goes when there is no previous screen in this tab - a link
      opened in a new tab, a reloaded page, the installed app's first screen.
      Defaults to home. */
  fallback?: string;
  onBack?: () => void;
  /** Icon button(s) on the right (share, filter, download, settings...). */
  action?: ReactNode;
  /** Span the whole content area (tab-root screens) instead of the narrow detail column. */
  wide?: boolean;
  /** The home button on the right - on every screen unless turned off. */
  home?: boolean;
}

const BUTTON =
  'cursor-pointer rounded-full bg-white/15 p-1.5 text-white ring-1 ring-white/25 outline-none transition hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white';

// The detail-screen header from the mockups: back arrow left, centred title,
// actions and a home button right. Distinct from AppHeader, which is the
// greeting-style header used on the tab roots.
export default function ScreenHeader({ title, back, fallback = '/', onBack, action, wide, home = true }: Props) {
  const navigate = useNavigate();
  const showBack = back !== undefined || !!onBack;

  const handleBack = () => {
    if (onBack) return onBack();
    if (typeof back === 'number') {
      if (back < 0 && !canGoBack()) return navigate(fallback, { replace: true });
      return navigate(back);
    }
    if (typeof back === 'string') return navigate(back);
  };

  return (
    <div className="sticky top-0 z-10 text-white shadow-lg shadow-slate-900/10" style={{ background: 'var(--band-bg)' }}>
      <div className={`mx-auto flex h-14 items-center gap-2 px-4 ${wide ? '' : 'max-w-3xl'}`}>
        <div className="flex w-[4.75rem] shrink-0 justify-start">
          {showBack && (
            <button type="button" onClick={handleBack} aria-label="Go back" className={`-ml-1 ${BUTTON}`}>
              <ArrowLeft size={20} aria-hidden />
            </button>
          )}
        </div>
        <p className="flex-1 truncate text-center font-display text-base font-bold tracking-[-0.02em] text-white">{title}</p>
        <div className="flex w-[4.75rem] shrink-0 items-center justify-end gap-1.5">
          {action}
          {home && (
            <button type="button" onClick={() => navigate('/')} aria-label="Go to home" title="Home" className={`-mr-1 ${BUTTON}`}>
              <Home size={20} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
