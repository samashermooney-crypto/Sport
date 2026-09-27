import { useEffect, useState } from 'react';

import { Card } from '../../ui';

import { communicationsRequest } from './api';

type HistoryItem = {
  id: string;
  campaignId: string | null;
  title: string;
  channel: string;
  status: string;
  recipientAccountId: string;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
};

/** Embed on a household profile for staff with communication-history permission. */
export function HouseholdMessageHistory({
  orgId,
  householdId,
}: {
  orgId: string;
  householdId: string;
}): React.JSX.Element {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [error, setError] = useState('');
  const path = `/orgs/${encodeURIComponent(orgId)}/households/${encodeURIComponent(householdId)}/history`;
  useEffect(() => {
    let active = true;
    void communicationsRequest<{ items: HistoryItem[] }>(path)
      .then((result) => {
        if (active) setItems(result.items);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not load message history.',
          );
      });
    return () => {
      active = false;
    };
  }, [path]);
  return (
    <Card className="messages-history">
      <h2>Message history</h2>
      {error ? (
        <div role="alert" className="messages-alert messages-alert--error">
          {error}
        </div>
      ) : items.length ? (
        <ol>
          {items.map((item) => (
            <li key={item.id}>
              <strong>{item.title}</strong>
              <span>
                {item.channel} · {item.status}
              </span>
              <time dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ol>
      ) : (
        <p>No message history is available for this household.</p>
      )}
    </Card>
  );
}
