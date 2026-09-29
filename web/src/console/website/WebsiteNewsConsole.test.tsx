import type { WebsiteNewsPost } from '@shared/schemas/website';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { i18n } from '../../lib/i18n';

import { WebsiteNewsConsole } from './WebsiteNewsConsole';

const orgId = '11111111-1111-4111-8111-111111111111';

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

it('creates and publishes a plain-text news post', async () => {
  await i18n.changeLanguage('en');
  const posts: WebsiteNewsPost[] = [];
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
      } else if (url.endsWith('/news') && method === 'GET') {
        result = { items: posts };
      } else if (url.endsWith('/news') && method === 'POST') {
        const body = JSON.parse(requestBody(init?.body)) as {
          slug: string;
          title: string;
          excerpt: string | null;
          bodyText: string;
          status: 'draft' | 'published';
        };
        const post: WebsiteNewsPost = {
          id: '22222222-2222-4222-8222-222222222222',
          ...body,
          publishedAt:
            body.status === 'published' ? '2026-09-27T12:31:00.000Z' : null,
          version: 1,
          updatedAt: '2026-09-27T12:31:00.000Z',
        };
        posts.push(post);
        result = { post };
        status = 201;
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
        <WebsiteNewsConsole orgId={orgId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(
    await screen.findByRole('heading', { name: 'Website news' }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Title/), {
    target: { value: 'Season opener' },
  });
  fireEvent.change(screen.getByLabelText(/Post address/), {
    target: { value: 'season-opener' },
  });
  fireEvent.change(screen.getByLabelText(/Post text/), {
    target: { value: 'Join us at the field Saturday.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Publish post' }));

  await waitFor(() => {
    const save = fetcher.mock.calls.find(
      ([input, init]) =>
        requestUrl(input).endsWith('/news') && init?.method === 'POST',
    );
    expect(save).toBeTruthy();
    expect(requestBody(save?.[1]?.body)).toContain('"status":"published"');
    expect(requestBody(save?.[1]?.body)).toContain(
      '"bodyText":"Join us at the field Saturday."',
    );
  });
  expect(await screen.findByText('Season opener')).toBeTruthy();
});
