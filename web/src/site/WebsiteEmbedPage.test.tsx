import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { WebsiteEmbedPage } from './WebsiteEmbedPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('renders a public widget from sanitized public data', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            organization: { slug: 'northstar', name: 'Northstar Youth Sports' },
            config: {
              kind: 'program_list',
              title: 'Programs',
              limit: 5,
            },
            program: null,
            items: [
              {
                label: 'Fall Soccer',
                href: '/site/northstar/programs/fall-soccer',
                detail: 'Registration is open.',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ),
  );
  const router = createMemoryRouter(
    [{ path: '/embed/:orgSlug/:publicKey', element: <WebsiteEmbedPage /> }],
    { initialEntries: [`/embed/northstar/${'K'.repeat(43)}`] },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  expect(await screen.findByRole('heading', { name: 'Programs' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Fall Soccer' })).toBeTruthy();
  expect(screen.getByText('Registration is open.')).toBeTruthy();
});
