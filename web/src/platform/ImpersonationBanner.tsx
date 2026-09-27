import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { platformApi } from './api';
import { clearImpersonation, currentImpersonationId } from './impersonation';
import './platform.css';

export type Impersonation = {
  id: string;
  organizationId: string;
  reason: string;
  readOnly: true;
  expiresAt: string;
};

export function ImpersonationBanner(): React.JSX.Element | null {
  const [current, setCurrent] = useState<Impersonation | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const refresh = () => {
      const id = currentImpersonationId();
      if (!id) {
        setCurrent(null);
        return;
      }
      void platformApi<Impersonation>(
        `/impersonations/${encodeURIComponent(id)}`,
      )
        .then((result) => {
          if (live) setCurrent(result);
        })
        .catch(() => {
          clearImpersonation();
          if (live) setCurrent(null);
        });
    };
    refresh();
    window.addEventListener('athlentry:impersonation', refresh);
    return () => {
      live = false;
      window.removeEventListener('athlentry:impersonation', refresh);
    };
  }, []);
  useEffect(() => {
    if (!current) return;
    const remaining = new Date(current.expiresAt).getTime() - Date.now();
    const timer = window.setTimeout(
      () => {
        clearImpersonation();
        setCurrent(null);
      },
      Math.max(0, remaining),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [current]);
  if (!current) return null;
  return (
    <aside className="platform-console__impersonation" role="status">
      Read-only impersonation for organization {current.organizationId} expires
      at{' '}
      <time dateTime={current.expiresAt}>
        {new Date(current.expiresAt).toLocaleString()}
      </time>
      .
      <Link to={`/orgs/${current.organizationId}/credentials`}>
        Review safety requirements
      </Link>
      <button
        type="button"
        onClick={() => {
          void platformApi(`/impersonations/${current.id}`, {
            method: 'DELETE',
          })
            .then(() => {
              clearImpersonation();
              setCurrent(null);
            })
            .catch((cause: unknown) => {
              setError(
                cause instanceof Error ? cause.message : 'Request failed.',
              );
            });
        }}
      >
        End impersonation
      </button>
      {error && <span role="alert">{error}</span>}
    </aside>
  );
}
