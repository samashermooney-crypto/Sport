import {
  Component,
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import type { PropsWithChildren } from 'react';
import { Link } from 'react-router';

import { ToastRegion } from './overlays';
import { ErrorState, Toast } from './primitives';

type NoticeTone = 'info' | 'success' | 'warning' | 'error';
type Notice = { id: number; message: string; tone: NoticeTone };
type Notify = (message: string, tone?: NoticeTone) => void;

const ToastContext = createContext<Notify | null>(null);

export function ToastProvider({
  children,
}: PropsWithChildren): React.JSX.Element {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(0);
  const notify = useCallback<Notify>((message, tone = 'info') => {
    const id = nextId.current++;
    setNotices((items) => [...items.slice(-2), { id, message, tone }]);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      {notices.length > 0 && (
        <ToastRegion>
          {notices.map((notice) => (
            <Toast
              key={notice.id}
              tone={notice.tone}
              onDismiss={() => {
                setNotices((items) =>
                  items.filter((item) => item.id !== notice.id),
                );
              }}
            >
              {notice.message}
            </Toast>
          ))}
        </ToastRegion>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error('ToastProvider is required');
  return notify;
}

export class AppErrorBoundary extends Component<
  PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    // Do not expose rendering errors or protected data to the browser UI.
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <main className="auth-frame">
          <ErrorState
            title="This page could not be displayed"
            onRetry={() => {
              this.setState({ failed: false });
            }}
          >
            Try again, or <Link to="/me">return to your account home</Link>.
          </ErrorState>
        </main>
      );
    }
    return this.props.children;
  }
}
