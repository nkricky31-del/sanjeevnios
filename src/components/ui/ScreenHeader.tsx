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
}

// The detail-screen header from the mockups: back arrow left, centred title,
// optional single icon action right. Distinct from AppHeader, which is the
// greeting-style header used on the tab roots.
export default function ScreenHeader({ title, back, onBack, action }: Props) {
  const navigate = useNavigate();
  const showBack = back !== undefined || !!onBack;

  const handleBack = () => {
    if (onBack) return onBack();
    if (typeof back === 'number') return navigate(back);
    if (typeof back === 'string') return navigate(back);
  };

  return (
    <div className="sticky top-0 z-10 border-b border-slate-100 bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-md items-center gap-2 px-4">
        <div className="flex w-10 justify-start">
          {showBack && (
            <button
              onClick={handleBack}
              aria-label="Go back"
              className="-ml-1 rounded-full p-1.5 text-slate-700 hover:bg-slate-100"
            >
              <ArrowLeft size={20} />
            </button>
          )}
        </div>
        <p className="flex-1 truncate text-center text-base font-bold text-slate-900">{title}</p>
        <div className="flex w-10 justify-end">{action}</div>
      </div>
    </div>
  );
}
