import { useCallback, useEffect, useState } from 'react';

import { Button, Field, Input } from '../../ui';

type CalendarFeedType = 'account' | 'team' | 'facility';
type CalendarFeed = { id: string; createdAt: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (
    init?.method &&
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(init.method.toUpperCase())
  )
    headers.set('X-Athlentry-Request', '1');
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers,
  });
  const payload =
    response.status === 204
      ? null
      : ((await response.json().catch(() => null)) as unknown);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String(payload.message)
        : `Calendar feed request failed (${String(response.status)}).`;
    throw new Error(message);
  }
  return payload as T;
}

export function CalendarFeedSubscription({
  orgId,
  type,
  id,
  label,
}: {
  orgId: string;
  type: CalendarFeedType;
  id?: string;
  label: string;
}): React.JSX.Element {
  const [feeds, setFeeds] = useState<CalendarFeed[]>([]);
  const [createdFeed, setCreatedFeed] = useState<{
    id: string;
    url: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const queryString = new URLSearchParams({
    type,
    ...(id ? { id } : {}),
  }).toString();
  const base = `/api/v1/scheduling/orgs/${encodeURIComponent(orgId)}/calendar-feeds`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request<{ items: CalendarFeed[] }>(
        `${base}?${queryString}`,
      );
      setFeeds(result.items);
      setError('');
      setCreatedFeed((current) =>
        current && result.items.some((feed) => feed.id === current.id)
          ? current
          : null,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Calendar subscriptions could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, [base, queryString]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await request<{ id: string; url: string }>(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, ...(id ? { id } : {}) }),
      });
      setCreatedFeed({
        id: result.id,
        url: new URL(result.url, window.location.origin).toString(),
      });
      setMessage('Calendar subscription created. Save this private URL now.');
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Calendar subscription could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(feedId: string): Promise<void> {
    if (
      !window.confirm(
        'Revoke this calendar URL? Any calendar app using it will stop receiving updates.',
      )
    )
      return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await request(`${base}/${encodeURIComponent(feedId)}`, {
        method: 'DELETE',
      });
      setMessage('Calendar URL revoked.');
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Calendar URL could not be revoked.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="schedule-card schedule-calendar-feeds"
      aria-label={`${label} calendar subscriptions`}
    >
      <div className="schedule-actions">
        <Button
          secondary
          disabled={busy || loading}
          onClick={() => void create()}
        >
          Create {label} calendar feed
        </Button>
      </div>
      {(error || message) && (
        <p
          role={error ? 'alert' : 'status'}
          className={
            error ? 'schedule-notice schedule-notice--error' : 'schedule-notice'
          }
        >
          {error || message}
        </p>
      )}
      {createdFeed && (
        <div className="schedule-calendar-feeds__created">
          <Field label={`${label} calendar URL`}>
            <Input readOnly value={createdFeed.url} />
          </Field>
          <p>
            This private URL appears only after creation. Add it to your
            calendar app and keep it private.
          </p>
        </div>
      )}
      {loading ? (
        <p role="status">Loading calendar subscriptions…</p>
      ) : feeds.length ? (
        <ul className="schedule-facility-list">
          {feeds.map((feed) => (
            <li key={feed.id}>
              <span>
                Active · created {new Date(feed.createdAt).toLocaleDateString()}
              </span>
              <Button
                secondary
                disabled={busy}
                onClick={() => void revoke(feed.id)}
              >
                Revoke URL
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        !error && <p>No active calendar subscriptions.</p>
      )}
    </section>
  );
}
