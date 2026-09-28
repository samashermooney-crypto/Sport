import { orgWorkspaceSchema } from '@shared/schemas/orgs';
import {
  websiteDomainListSchema,
  websiteDomainResponseSchema,
} from '@shared/schemas/website';
import type { WebsiteDomain } from '@shared/schemas/website';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { apiGet, apiPost } from '../../api/client';
import { Button, Card, Field, Input, Link } from '../../ui/primitives';
import { AppShell } from '../../ui/shell';
import './website.css';

export function WebsiteDomainsConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [host, setHost] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () => apiGet(`/orgs/${orgId}/workspace`, orgWorkspaceSchema),
  });
  const domains = useQuery({
    queryKey: ['orgs', orgId, 'website-domains'],
    queryFn: () =>
      apiGet(`/website/orgs/${orgId}/domains`, websiteDomainListSchema),
  });
  const refresh = async () =>
    queryClient.invalidateQueries({
      queryKey: ['orgs', orgId, 'website-domains'],
    });
  const addDomain = useMutation({
    mutationFn: (value: string) =>
      apiPost(
        `/website/orgs/${orgId}/domains`,
        { host: value },
        websiteDomainResponseSchema,
      ),
    onSuccess: async ({ domain }) => {
      setHost('');
      setError(null);
      setNotice(`${domain.host} is ready for DNS ownership verification.`);
      await refresh();
    },
    onError: (cause: Error) => {
      setError(cause.message);
    },
  });
  const updateDomain = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: 'verify' | 'primary' | 'disable';
    }) =>
      apiPost(
        `/website/orgs/${orgId}/domains/${id}/${action}`,
        {},
        websiteDomainResponseSchema,
      ),
    onSuccess: async ({ domain }) => {
      setError(null);
      setNotice(`${domain.host}: ${domain.statusNote ?? domain.status}`);
      await refresh();
    },
    onError: (cause: Error) => {
      setError(cause.message);
    },
  });

  if (workspace.isPending || domains.isPending)
    return <p role="status">Loading website domains…</p>;
  if (workspace.isError || domains.isError)
    return <main role="alert">Website domains could not be loaded.</main>;

  const workspaceData = workspace.data;
  const websitePath = `/console/orgs/${orgId}/website`;
  const navigation = [
    { label: 'Home', to: `/console/orgs/${orgId}` },
    { label: 'Website pages', to: websitePath },
    { label: 'Website settings', to: `${websitePath}/settings` },
    { label: 'Domains', to: `${websitePath}/domains`, current: true },
    { label: 'Embeds', to: `${websitePath}/embeds` },
    { label: 'Reports', to: `/console/orgs/${orgId}/reports` },
    { label: 'Account', to: '/me' },
  ];
  const currentDomains = domains.data.items;

  function renderDomain(domain: WebsiteDomain): React.JSX.Element {
    const busy = updateDomain.isPending;
    return (
      <Card key={domain.id} className="website-domain-card">
        <header>
          <div>
            <h2>{domain.host}</h2>
            <p>
              Status: <strong>{domain.status}</strong>
              {domain.isPrimary ? ' · Primary website domain' : ''}
            </p>
          </div>
        </header>
        {domain.statusNote && <p>{domain.statusNote}</p>}
        {domain.verificationToken && (
          <div className="website-domain-dns">
            <p>
              Add this TXT record at your DNS provider. The host must keep the
              record in place while the domain is connected.
            </p>
            <dl>
              <div>
                <dt>Record name</dt>
                <dd>
                  <code>{domain.verificationRecordName}</code>
                </dd>
              </div>
              <div>
                <dt>TXT value</dt>
                <dd>
                  <code>{domain.verificationToken}</code>
                </dd>
              </div>
            </dl>
          </div>
        )}
        <div className="website-page-actions">
          {domain.status !== 'disabled' && (
            <Button
              secondary
              disabled={busy}
              onClick={() => {
                updateDomain.mutate({ id: domain.id, action: 'verify' });
              }}
            >
              {updateDomain.isPending && updateDomain.variables.id === domain.id
                ? 'Checking…'
                : 'Check DNS and TLS'}
            </Button>
          )}
          {domain.status === 'active' && !domain.isPrimary && (
            <Button
              secondary
              disabled={busy}
              onClick={() => {
                updateDomain.mutate({ id: domain.id, action: 'primary' });
              }}
            >
              Set as primary
            </Button>
          )}
          {domain.status !== 'disabled' && (
            <Button
              secondary
              disabled={busy}
              onClick={() => {
                updateDomain.mutate({ id: domain.id, action: 'disable' });
              }}
            >
              Disable domain
            </Button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <AppShell
      orgName={workspaceData.name}
      navigation={[{ label: 'Manage', items: navigation }]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        { label: 'Website', to: websitePath, current: true },
        { label: 'Account', to: '/me' },
      ]}
    >
      <main className="page-content">
        <header className="page-heading">
          <div>
            <p className="eyebrow">Public organization site</p>
            <h1>Website domains</h1>
            <p>
              Verify ownership and TLS before routing visitors to a custom
              domain.
            </p>
          </div>
          <Link to={websitePath}>Edit website pages</Link>
        </header>
        <Card>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              addDomain.mutate(host);
            }}
          >
            <h2>Add a custom domain</h2>
            <Field
              label="Hostname"
              hint="Enter a hostname such as club.example.org. Do not include https:// or a path."
              required
            >
              <Input
                required
                type="text"
                autoComplete="url"
                maxLength={253}
                pattern="(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}"
                value={host}
                onChange={(event) => {
                  setHost(event.currentTarget.value);
                }}
              />
            </Field>
            <Button type="submit" disabled={addDomain.isPending}>
              {addDomain.isPending ? 'Adding…' : 'Add domain'}
            </Button>
          </form>
        </Card>
        <p role="note">
          A custom domain becomes active only after its ownership TXT record and
          trusted TLS certificate are both verified. Work with your DNS provider
          to add the record shown for each hostname.
        </p>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <section aria-labelledby="website-domain-list-title">
          <h2 id="website-domain-list-title">Connected domains</h2>
          {currentDomains.length ? (
            <div className="website-domain-list">
              {currentDomains.map(renderDomain)}
            </div>
          ) : (
            <p>No custom domains are connected.</p>
          )}
        </section>
      </main>
    </AppShell>
  );
}
