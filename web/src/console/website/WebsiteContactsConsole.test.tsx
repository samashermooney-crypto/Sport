import type { WebsiteContactSubmission } from '@shared/schemas/website';
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

import { WebsiteContactsConsole } from './WebsiteContactsConsole';

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

it('shows the inbox and marks all new website messages read', async () => {
  await i18n.changeLanguage('en');
  const submissions: WebsiteContactSubmission[] = [
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Avery Parent',
      email: 'avery@example.invalid',
      subject: 'Tryout dates',
      body: 'When will tryouts begin?',
      status: 'new',
      createdAt: '2026-09-28T18:00:00.000Z',
    },
  ];
  const fetcher = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/workspace'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: orgId,
              name: 'Northstar Youth Sports',
              slug: 'northstar',
              canManage: true,
              canAudit: true,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      if (url.endsWith('/contact-submissions/mark-read') && method === 'POST') {
        const updatedCount = submissions.filter(
          (submission) => submission.status === 'new',
        ).length;
        for (const submission of submissions)
          if (submission.status === 'new') submission.status = 'read';
        return Promise.resolve(
          new Response(JSON.stringify({ updatedCount }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.endsWith('/contact-submissions'))
        return Promise.resolve(
          new Response(JSON.stringify({ items: submissions }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      throw new Error(`Unexpected request: ${method} ${url}`);
    },
  );
  vi.stubGlobal('fetch', fetcher);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WebsiteContactsConsole orgId={orgId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(
    await screen.findByRole('heading', { name: 'Contact inbox' }),
  ).toBeTruthy();
  expect(screen.getByText('Northstar Youth Sports')).toBeTruthy();
  expect(screen.getByText('When will tryouts begin?')).toBeTruthy();
  expect(screen.getByText('1 unread message')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
  expect(await screen.findByText('1 message marked as read.')).toBeTruthy();
  await waitFor(() => {
    expect(
      screen.getByRole('button', { name: 'Mark all read' }),
    ).toHaveProperty('disabled', true);
  });
  const markReadCall = fetcher.mock.calls.find(
    ([input, init]) =>
      requestUrl(input).endsWith('/contact-submissions/mark-read') &&
      init?.method === 'POST',
  );
  expect(markReadCall).toBeDefined();
  const requestInit = markReadCall?.[1];
  expect(requestInit?.method).toBe('POST');
  expect(
    (requestInit?.headers as Record<string, string> | undefined)?.[
      'X-Athlentry-Request'
    ],
  ).toBe('1');
  expect(requestInit?.body).toBe('{}');
});
