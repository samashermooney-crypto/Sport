import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { i18n } from '../../lib/i18n';

import { ActionCenter } from './ActionCenter';

const orgId = '11111111-1111-4111-8111-111111111111';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows permitted operational queues and their working destinations', async () => {
  const fetcher = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          cards: [
            {
              id: 'past-due-balances',
              title: 'Past-due unpaid balances',
              count: 2,
              amountCents: 2450,
              actionLabel: 'Review receivables',
              href: `/console/orgs/${orgId}/reports`,
              items: [
                {
                  id: 'invoice-1',
                  label: 'Invoice #42',
                  detail: 'Due Sep 1',
                  href: `/console/orgs/${orgId}/reports`,
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
  vi.stubGlobal('fetch', fetcher);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActionCenter orgId={orgId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(
    await screen.findByRole('heading', { name: 'Action Center' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('heading', { name: 'Past-due unpaid balances' }),
  ).toBeTruthy();
  expect(screen.getByText('2')).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Invoice #42: Due Sep 1' }),
  ).toHaveProperty(
    'href',
    `http://localhost:3000/console/orgs/${orgId}/reports`,
  );
  expect(fetcher).toHaveBeenCalledWith(
    `/api/v1/action-center/orgs/${orgId}/action-center`,
    expect.objectContaining({ method: 'GET' }),
  );
});

it('marks all unread website contacts read from the queue card', async () => {
  await i18n.changeLanguage('en');
  let unread = true;
  const fetcher = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (url.endsWith('/contact-submissions/mark-read')) {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({ 'X-Athlentry-Request': '1' });
        unread = false;
        return Promise.resolve(
          new Response(JSON.stringify({ updatedCount: 2 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            cards: unread
              ? [
                  {
                    id: 'unread-contacts',
                    title: 'Unread website contact submissions',
                    count: 2,
                    bulkAction: 'mark_contacts_read',
                    actionLabel: 'Open contact inbox',
                    href: `/console/orgs/${orgId}/website/contacts`,
                    items: [],
                  },
                ]
              : [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
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
        <ActionCenter orgId={orgId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(
    await screen.findByRole('heading', {
      name: 'Unread website contact submissions',
    }),
  ).toBeTruthy();
  screen.getByRole('button', { name: 'Mark all read' }).click();
  expect(await screen.findByText('2 messages marked as read.')).toBeTruthy();
  expect(await screen.findByText('Everything is up to date')).toBeTruthy();
});
