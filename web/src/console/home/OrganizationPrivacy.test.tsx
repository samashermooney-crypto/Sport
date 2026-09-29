import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { OrganizationPrivacy } from './OrganizationPrivacy';

const orgId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const personId = '33333333-3333-4333-8333-333333333333';

afterEach(() => vi.unstubAllGlobals());

it('creates a privacy request and refreshes the organization queue', async () => {
  let requestCreated = false;
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
      if (
        url.endsWith(`/exports/orgs/${orgId}/privacy-requests`) &&
        method === 'GET'
      ) {
        result = {
          items: requestCreated
            ? [
                {
                  id: requestId,
                  kind: 'correction',
                  subjectType: 'person',
                  subjectId: personId,
                  status: 'pending',
                  resolutionNote: null,
                  version: 1,
                  createdAt: '2026-09-27T18:00:00.000Z',
                  updatedAt: '2026-09-27T18:00:00.000Z',
                },
              ]
            : [],
        };
      } else if (url.endsWith(`/exports/orgs/${orgId}/retention-policy`)) {
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
      } else if (
        url.endsWith(`/exports/orgs/${orgId}/privacy-requests`) &&
        method === 'POST'
      ) {
        requestCreated = true;
        result = {
          id: requestId,
          kind: 'correction',
          subjectType: 'person',
          subjectId: personId,
          status: 'pending',
          resolutionNote: null,
          version: 1,
          createdAt: '2026-09-27T18:00:00.000Z',
          updatedAt: '2026-09-27T18:00:00.000Z',
        };
      } else {
        throw new Error(`Unexpected request: ${method} ${url}`);
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
        <OrganizationPrivacy orgId={orgId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(
    await screen.findByText('No privacy requests have been created.'),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Request type'), {
    target: { value: 'correction' },
  });
  fireEvent.change(screen.getByLabelText('Subject ID'), {
    target: { value: personId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create request' }));

  expect(
    await screen.findByText(`Privacy request created (${requestId}).`),
  ).toBeTruthy();
  const requestListReads = fetcher.mock.calls.filter(([input, init]) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return (
      url.endsWith(`/exports/orgs/${orgId}/privacy-requests`) &&
      (!init?.method || init.method === 'GET')
    );
  });
  expect(requestListReads).toHaveLength(2);
  expect(await screen.findByText(`correction · person`)).toBeTruthy();
  expect(await screen.findByText('pending')).toBeTruthy();
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
  const postBody = post?.[1]?.body;
  if (typeof postBody !== 'string')
    throw new Error('Expected the privacy request body to be JSON text');
  expect(JSON.parse(postBody)).toEqual({
    kind: 'correction',
    subjectType: 'person',
    subjectId: personId,
  });
});
