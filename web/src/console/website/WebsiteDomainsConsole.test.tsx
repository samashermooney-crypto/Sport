import type { WebsiteDomain } from '@shared/schemas/website';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { WebsiteDomainsConsole } from './WebsiteDomainsConsole';

const orgId = '11111111-1111-4111-8111-111111111111';
const domainId = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-09-28T12:00:00.000Z';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestBody(body: BodyInit | null | undefined): string {
  return typeof body === 'string' ? body : '';
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('adds a custom hostname and verifies DNS and TLS before primary use', async () => {
  const domains: WebsiteDomain[] = [];
  const fetcher = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';
      let result: unknown;
      let status = 200;
      if (url.endsWith('/workspace')) {
        result = {
          id: orgId,
          name: 'Northstar Youth Sports',
          slug: 'northstar',
          canManage: true,
          canAudit: true,
        };
      } else if (url.endsWith('/domains') && method === 'GET') {
        result = { items: domains };
      } else if (url.endsWith('/domains') && method === 'POST') {
        const body = JSON.parse(requestBody(init?.body)) as { host: string };
        const domain: WebsiteDomain = {
          id: domainId,
          host: body.host,
          status: 'pending',
          isPrimary: false,
          verificationRecordName: `_athlentry-verification.${body.host}`,
          verificationToken: 'A'.repeat(43),
          verifiedAt: null,
          lastCheckedAt: null,
          statusNote: null,
          version: 1,
          updatedAt: stamp,
        };
        domains.push(domain);
        result = { domain };
        status = 201;
      } else if (url.endsWith(`/domains/${domainId}/verify`)) {
        const current = domains[0];
        if (!current) throw new Error('Expected the custom domain to exist');
        const domain: WebsiteDomain = {
          ...current,
          status: 'active',
          isPrimary: false,
          verificationToken: null,
          verifiedAt: stamp,
          lastCheckedAt: stamp,
          statusNote: 'Ownership and TLS certificate verified.',
          version: current.version + 1,
        };
        domains[0] = domain;
        result = { domain };
      } else {
        throw new Error(`Unexpected request: ${method} ${url}`);
      }
      return Promise.resolve(
        new Response(JSON.stringify(result), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
  );
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WebsiteDomainsConsole orgId={orgId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(
    await screen.findByRole('heading', { name: 'Website domains' }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Hostname/), {
    target: { value: 'club.example.org' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add domain' }));
  expect(
    await screen.findByText('_athlentry-verification.club.example.org'),
  ).toBeTruthy();
  expect(await screen.findByText('A'.repeat(43))).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Check DNS and TLS' }));

  expect(
    await screen.findByText('active', { selector: 'strong' }),
  ).toBeTruthy();
  expect(
    fetcher.mock.calls.some(
      ([input, init]) =>
        requestUrl(input).endsWith(`/domains/${domainId}/verify`) &&
        init?.method === 'POST',
    ),
  ).toBe(true);
  expect(screen.getByRole('button', { name: 'Set as primary' })).toBeTruthy();
});
