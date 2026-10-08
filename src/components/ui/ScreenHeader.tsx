import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

interface Props {
  title: string;
  /** Where the back arrow goes. Omit for no back arrow; -1 means browser back. */
  back?: string | number;
  onBack?: () => void;
  /** Icon button(s) on the right (share, filter, download, settings...). */
  action?: ReactNode;
  /** Span the whole content area (tab-root screens) instead of the narrow detail column. */
  wide?: boolean;
}

// The detail-screen header from the mockups: back arrow left, centred title,
// optional single icon action right. Distinct from AppHeader, which is the
// greeting-style header used on the tab roots.
export default function ScreenHeader({ title, back, onBack, action, wide }: Props) {
  const navigate = useNavigate();
  const showBack = back !== undefined || !!onBack;

  const handleBack = () => {
    if (onBack) return onBack();
    if (typeof back === 'number') return navigate(back);
    if (typeof back === 'string') return navigate(back);
  };

  return (
    <div className="sticky top-0 z-10 text-white shadow-lg shadow-slate-900/10" style={{ background: 'var(--band-bg)' }}>
      <div className={`mx-auto flex h-14 items-center gap-2 px-4 ${wide ? '' : 'max-w-3xl'}`}>
        <div className="flex w-10 justify-start">
          {showBack && (
            <button
              onClick={handleBack}
              aria-label="Go back"
              className="-ml-1 cursor-pointer rounded-full bg-white/15 p-1.5 text-white ring-1 ring-white/25 outline-none transition hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white"
            >
              <ArrowLeft size={20} />
            </button>
          )}
        </div>
        <p className="flex-1 truncate text-center font-display text-base font-bold tracking-[-0.02em] text-white">{title}</p>
        <div className="flex w-10 justify-end">{action}</div>
      </div>
    </div>
  );
}
