import { useEffect, useState } from 'react';

import './notification-center.css';

type Notification = {
  id: string;
  title: string;
  createdAt: string;
  readAt: string | null;
  payload: { href?: string };
};
type InboxPage = { items: Notification[]; nextCursor: string | null };
type Preference = {
  category: 'operational' | 'announcement' | 'marketing' | 'emergency';
  channel: 'in_app' | 'email';
  enabled: boolean;
  version: number;
};

export function NotificationCenter({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const [page, setPage] = useState<InboxPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [revision, setRevision] = useState(0);
  const base = `/api/v1/notifications/orgs/${encodeURIComponent(orgId)}`;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    void Promise.all([
      fetch(`${base}/inbox?${query}`, {
        credentials: 'include',
        signal: controller.signal,
      }),
      fetch(`${base}/preferences`, {
        credentials: 'include',
        signal: controller.signal,
      }),
    ])
      .then(async ([inboxResponse, preferenceResponse]) => {
        if (!inboxResponse.ok || !preferenceResponse.ok)
          throw new Error('Could not load notifications.');
        return Promise.all([
          inboxResponse.json() as Promise<InboxPage>,
          preferenceResponse.json() as Promise<{ items: Preference[] }>,
        ]);
      })
      .then(([inbox, settings]) => {
        setPage(inbox);
        setPreferences(settings.items);
        setError('');
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Could not load notifications.');
      });
    return () => {
      controller.abort();
    };
  }, [base, cursor, revision]);

  useEffect(() => {
    const stream = new EventSource('/api/v1/stream', { withCredentials: true });
    stream.addEventListener('notification', () => {
      setCursor(null);
      setRevision((value) => value + 1);
    });
    return () => {
      stream.close();
    };
  }, []);

  async function markRead(id: string): Promise<void> {
    setBusy(id);
    try {
      const response = await fetch(
        `${base}/inbox/${encodeURIComponent(id)}/read`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'X-Athlentry-Request': '1' },
        },
      );
      if (!response.ok)
        throw new Error('Could not mark the notification read.');
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      setBusy('');
    }
  }

  async function togglePreference(preference: Preference): Promise<void> {
    const key = `${preference.category}:${preference.channel}`;
    setBusy(key);
    try {
      const response = await fetch(
        `${base}/preferences/${preference.category}/${preference.channel}`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Athlentry-Request': '1',
          },
          body: JSON.stringify({
            enabled: !preference.enabled,
            expectedVersion: preference.version,
          }),
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 400
            ? 'Operational and emergency alerts need an enabled channel.'
            : 'Could not update the preference.',
        );
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      setBusy('');
    }
  }

  return (
    <main className="notification-center">
      <header>
        <h1>Notifications</h1>
        <button
          type="button"
          onClick={() => {
            setRevision((value) => value + 1);
          }}
        >
          Refresh
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      <section aria-labelledby="inbox-title">
        <h2 id="inbox-title">Inbox</h2>
        {page === null ? (
          <p role="status">Loading notifications…</p>
        ) : page.items.length === 0 ? (
          <p>No notifications yet.</p>
        ) : (
          <ul className="notification-center__inbox">
            {page.items.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <time dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                  {item.payload.href && <a href={item.payload.href}>Open</a>}
                </div>
                {!item.readAt && (
                  <button
                    type="button"
                    disabled={busy === item.id}
                    onClick={() => void markRead(item.id)}
                  >
                    Mark read
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {cursor && (
          <button
            type="button"
            onClick={() => {
              setCursor(null);
            }}
          >
            First page
          </button>
        )}
        {page?.nextCursor && (
          <button
            type="button"
            onClick={() => {
              setCursor(page.nextCursor);
            }}
          >
            Next page
          </button>
        )}
      </section>
      <section aria-labelledby="preferences-title">
        <h2 id="preferences-title">Delivery preferences</h2>
        <div className="notification-center__preferences">
          {preferences.map((preference) => {
            const key = `${preference.category}:${preference.channel}`;
            return (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={preference.enabled}
                  disabled={busy === key}
                  onChange={() => void togglePreference(preference)}
                />
                {preference.category} ·{' '}
                {preference.channel === 'in_app' ? 'In app' : 'Email'}
              </label>
            );
          })}
        </div>
      </section>
    </main>
  );
}
