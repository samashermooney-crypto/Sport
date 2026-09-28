import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { OrganizationData } from './OrganizationData';

const orgId = '11111111-1111-4111-8111-111111111111';
const exportId = '22222222-2222-4222-8222-222222222222';

afterEach(() => vi.unstubAllGlobals());

it('lists an archive, creates a secure link and requests a new export', async () => {
  const fetcher = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? 'GET';
      let result: unknown;
      if (url.endsWith(`/exports/orgs/${orgId}/exports`) && method === 'GET') {
        result = {
          items: [
            {
              id: exportId,
              status: 'ready',
              bytes: 2048,
              expiresAt: '2026-10-04T18:00:00.000Z',
              createdAt: '2026-09-27T18:00:00.000Z',
            },
          ],
        };
      } else if (
        url.endsWith(`/exports/orgs/${orgId}/privacy-requests`) &&
        method === 'GET'
      ) {
        result = { items: [] };
      } else if (
        url.endsWith(`/exports/orgs/${orgId}/retention-policy`) &&
        method === 'GET'
      ) {
        result = {
          version: 1,
          rules: {
            financialRecordsYears: 7,
            waiverAndSafetyYearsAfterAge18: 7,
            waiverAndSafetyYearsAfterEvent: 7,
            backgroundCheckValidityPlusYears: 1,
            messagesYears: 3,
            evaluationScoresYearsAfterEvent: 2,
            expiredTokensDays: 30,
          },
          updatedAt: '2026-09-27T18:00:00.000Z',
        };
      } else if (url.endsWith('/download-link')) {
        result = {
          url: 'https://athlentry.example.test/api/v1/exports/download/abc',
          expiresAt: '2026-10-04T18:00:00.000Z',
        };
      } else {
        result = {
          export: {
            id: exportId,
            status: 'queued',
            bytes: null,
            expiresAt: null,
            createdAt: '2026-09-27T18:00:00.000Z',
          },
        };
      }
      return Promise.resolve(
        new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
  );
  vi.stubGlobal('fetch', fetcher);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OrganizationData orgId={orgId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText('ready')).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Create secure download link' }),
  );
  expect(
    await screen.findByRole('link', { name: 'Download organization ZIP' }),
  ).toHaveProperty(
    'href',
    'https://athlentry.example.test/api/v1/exports/download/abc',
  );

  fireEvent.click(screen.getByRole('button', { name: 'Request export' }));
  expect((await screen.findByRole('status')).textContent).toContain(
    'Export request queued',
  );
  expect(fetcher).toHaveBeenCalledWith(
    `/api/v1/exports/orgs/${orgId}/exports`,
    expect.objectContaining({ method: 'POST' }),
  );
});
