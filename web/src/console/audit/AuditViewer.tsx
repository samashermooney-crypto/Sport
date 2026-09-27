import { useEffect, useState } from 'react';

import {
  impersonationHeaders,
  useImpersonationId,
} from '../../platform/impersonation';

import './audit-viewer.css';

type AuditEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorAccountId: string | null;
  createdAt: string;
  changes: Record<string, unknown>;
};
type AuditPage = { items: AuditEntry[]; nextCursor: string | null };

export function AuditViewer({ orgId }: { orgId: string }): React.JSX.Element {
  const [entityTypeInput, setEntityTypeInput] = useState('');
  const [entityType, setEntityType] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState<AuditPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const impersonationId = useImpersonationId();

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: '50' });
    if (entityType) query.set('entityType', entityType);
    if (cursor) query.set('cursor', cursor);
    setLoading(true);
    setError('');
    void fetch(`/api/v1/audit/orgs/${encodeURIComponent(orgId)}?${query}`, {
      credentials: 'include',
      headers: impersonationHeaders(impersonationId),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? 'Audit history is unavailable for this account.'
              : 'Could not load audit history.',
          );
        return (await response.json()) as AuditPage;
      })
      .then((result) => {
        setPage(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not load audit history.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [orgId, entityType, cursor, impersonationId, revision]);

  return (
    <main className="audit-viewer">
      <header className="audit-viewer__header">
        <h1>Audit history</h1>
        <p>Changes and access to protected records</p>
      </header>
      <form
        className="audit-viewer__filters"
        onSubmit={(event) => {
          event.preventDefault();
          setCursor(null);
          setEntityType(entityTypeInput.trim());
          setRevision((value) => value + 1);
        }}
      >
        <label htmlFor="audit-entity-type">Record type</label>
        <input
          id="audit-entity-type"
          value={entityTypeInput}
          onChange={(event) => {
            setEntityTypeInput(event.target.value);
          }}
          maxLength={100}
        />
        <button type="submit">Search</button>
      </form>
      {error && (
        <div role="alert" className="audit-viewer__error">
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              setRevision((value) => value + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {loading ? (
        <p role="status">Loading audit history…</p>
      ) : page?.items.length ? (
        <div className="audit-viewer__table-wrap">
          <table className="audit-viewer__table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Record</th>
                <th>Actor</th>
                <th>Changes</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </td>
                  <td>{entry.action}</td>
                  <td>
                    {entry.entityType}
                    {entry.entityId ? ` · ${entry.entityId}` : ''}
                  </td>
                  <td>{entry.actorAccountId ?? 'System'}</td>
                  <td>
                    <code>{JSON.stringify(entry.changes)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !error && <p>No audit entries found.</p>
      )}
      <div className="audit-viewer__pagination">
        <button
          type="button"
          disabled={!cursor || loading}
          onClick={() => {
            setCursor(null);
          }}
        >
          First page
        </button>
        <button
          type="button"
          disabled={!page?.nextCursor || loading}
          onClick={() => {
            setCursor(page?.nextCursor ?? null);
          }}
        >
          Next page
        </button>
      </div>
    </main>
  );
}
