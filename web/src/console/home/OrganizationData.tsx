import {
  organizationExportDownloadLinkSchema,
  organizationExportListSchema,
  organizationExportRequestResponseSchema,
} from '@shared/schemas/exports';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { apiGet, apiPost } from '../../api/client';
import { Button, Card, Link } from '../../ui/primitives';

import { OrganizationPrivacy } from './OrganizationPrivacy';

import '../home.css';

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function formatBytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1024) return `${String(value)} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let amount = value / 1024;
  let unit = units[0] ?? 'KB';
  for (const next of units.slice(1)) {
    if (amount < 1024) break;
    amount /= 1024;
    unit = next;
  }
  return `${amount.toFixed(1)} ${unit}`;
}

export function OrganizationData({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const base = `/exports/orgs/${encodeURIComponent(orgId)}/exports`;
  const exportsQuery = useQuery({
    queryKey: ['orgs', orgId, 'organization-exports'],
    queryFn: () => apiGet(base, organizationExportListSchema),
  });
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    setError('');
    setNotice('');
    await queryClient.invalidateQueries({
      queryKey: ['orgs', orgId, 'organization-exports'],
    });
  }

  async function requestExport() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiPost(
        base,
        {},
        organizationExportRequestResponseSchema,
      );
      await refresh();
      setNotice(`Export request queued (${result.export.id}).`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The organization export could not be requested.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function createDownloadLink(exportId: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiPost(
        `${base}/${encodeURIComponent(exportId)}/download-link`,
        {},
        organizationExportDownloadLinkSchema,
      );
      setLinks((current) => ({ ...current, [exportId]: result.url }));
      setNotice(`Download link expires ${formatDate(result.expiresAt)}.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'A download link could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="console-home">
      <header className="console-home__header">
        <div>
          <p className="console-home__eyebrow">ORGANIZATION DATA</p>
          <h1>Exports</h1>
          <p>
            Create an archive of organization records and a manifest of stored
            files. Export requests and download links require a recent sign-in.
          </p>
        </div>
        <div className="console-home__actions">
          <Button
            type="button"
            secondary
            disabled={busy || exportsQuery.isFetching}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void requestExport()}
          >
            Request export
          </Button>
        </div>
      </header>

      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {exportsQuery.isPending ? (
        <p role="status">Loading exports…</p>
      ) : exportsQuery.isError ? (
        <p role="alert">Organization exports are unavailable.</p>
      ) : exportsQuery.data.items.length === 0 ? (
        <Card>
          <h2>No organization exports</h2>
          <p>Request an archive when your organization needs a data copy.</p>
        </Card>
      ) : (
        <div className="console-home__cards">
          {exportsQuery.data.items.map((item) => (
            <Card key={item.id}>
              <h2>Export {item.id.slice(0, 8)}</h2>
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd>{item.status}</dd>
                </div>
                <div>
                  <dt>Requested</dt>
                  <dd>{formatDate(item.createdAt)}</dd>
                </div>
                <div>
                  <dt>Archive size</dt>
                  <dd>{formatBytes(item.bytes)}</dd>
                </div>
                <div>
                  <dt>Available until</dt>
                  <dd>{formatDate(item.expiresAt)}</dd>
                </div>
              </dl>
              {item.status === 'ready' && item.expiresAt && (
                <>
                  <Button
                    type="button"
                    secondary
                    disabled={busy}
                    onClick={() => void createDownloadLink(item.id)}
                  >
                    Create secure download link
                  </Button>
                  {links[item.id] && (
                    <p>
                      <a href={links[item.id]}>Download organization ZIP</a>
                    </p>
                  )}
                </>
              )}
            </Card>
          ))}
        </div>
      )}
      <p>
        A download link is valid for up to seven days. For a step-up prompt,{' '}
        <Link to="/me/security">open account security</Link> and return here.
      </p>
      <OrganizationPrivacy orgId={orgId} />
    </main>
  );
}
