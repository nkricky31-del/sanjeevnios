import { RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

// A part of the app that won't download - nearly always because a new
// version went live while this tab was open (lib/lazyPage.ts already reloads
// once for that; this is what shows if the reload didn't fix it).
const isLoadError = (error: unknown) =>
  error instanceof Error &&
  /dynamically imported module|Importing a module script failed|Failed to fetch|error loading dynamically/i.test(error.message);

interface Props {
  resetKey: string;
  children: ReactNode;
}
interface State {
  error: unknown;
  resetKey: string;
}

class Boundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  // Going to another screen (or Back) gets a fresh try.
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Screen failed to render:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const loadError = isLoadError(this.state.error);
    const [title, body] = offline
      ? ["You're offline", 'This screen needs the internet to open. Reconnect, then reload.']
      : loadError
        ? ['SanjeevniOS has been updated', 'Reload to get the latest version. Nothing you saved is lost.']
        : [
            'Something went wrong on this screen',
            'Reload to try again. If it keeps happening, check your internet connection and try again in a few minutes.',
          ];
    return (
      <div className="flex min-h-screen items-center justify-center bg-ground px-4 font-ui text-ink">
        <div role="alert" className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <p className="text-lg font-bold text-slate-900">{title}</p>
          <p className="mt-2 text-sm text-slate-600">{body}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white outline-none hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            <RefreshCw size={16} aria-hidden /> Reload
          </button>
          <a href="/" className="mt-3 block text-sm font-medium text-slate-500 hover:text-slate-700">
            Go to the home screen
          </a>
        </div>
      </div>
    );
  }
}

// Keeps one broken screen from blanking the whole app: shows a way out
// instead, and clears itself when the person moves to another screen.
export default function AppErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <Boundary resetKey={location.pathname}>{children}</Boundary>;
}
