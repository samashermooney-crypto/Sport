import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { OnboardingChecklist } from './OnboardingChecklist';

const orgId = '0199a413-a221-7000-8000-000000000011';

function setupItem(
  key: 'connect_payments' | 'import_members',
  label: string,
  state: 'pending' | 'complete' | 'dismissed',
) {
  return {
    key,
    label,
    href: `/console/orgs/${orgId}/onboarding`,
    description: `Set up ${label.toLowerCase()}.`,
    state,
    completedAt: state === 'complete' ? '2026-09-28T00:00:00.000Z' : null,
    dismissedAt: state === 'dismissed' ? '2026-09-28T00:00:00.000Z' : null,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderChecklist(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OnboardingChecklist orgId={orgId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('announces while the saved setup checklist loads', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  );

  renderChecklist();

  expect(screen.getByRole('status').textContent).toContain(
    'Loading your setup checklist…',
  );
});

it('shows a retry state when setup progress fails to load', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ message: 'Unavailable' }, 503))
    .mockResolvedValueOnce(
      jsonResponse({
        items: [setupItem('connect_payments', 'Connect payments', 'pending')],
        completeCount: 0,
      }),
    );
  vi.stubGlobal('fetch', fetchMock);

  renderChecklist();

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(
    'Your setup progress is unavailable right now.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(
    await screen.findByRole('button', { name: 'Dismiss Connect payments' }),
  ).toBeTruthy();
});

it('restores a dismissed step after the whole checklist was hidden', async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      jsonResponse({
        items: [
          setupItem('connect_payments', 'Connect payments', 'dismissed'),
          setupItem('import_members', 'Import members', 'dismissed'),
        ],
        completeCount: 0,
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(
      jsonResponse({
        items: [
          setupItem('connect_payments', 'Connect payments', 'pending'),
          setupItem('import_members', 'Import members', 'dismissed'),
        ],
        completeCount: 0,
      }),
    );
  vi.stubGlobal('fetch', fetchMock);

  renderChecklist();

  expect(
    await screen.findByText(
      'All setup steps are hidden. Restore a step below to continue.',
    ),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Restore Connect payments' }),
  );

  expect(
    await screen.findByRole('button', { name: 'Dismiss Connect payments' }),
  ).toBeTruthy();
  const restoreRequest = fetchMock.mock.calls.find(
    ([input]) =>
      input === '/api/v1/onboarding/checklist/connect_payments/restore',
  );
  expect(restoreRequest).toBeDefined();
  if (!restoreRequest) throw new Error('Restore request was not sent');
  expect(restoreRequest[1]?.method).toBe('POST');
  expect(
    new Headers(restoreRequest[1]?.headers ?? {}).get('X-Athlentry-Org'),
  ).toBe(orgId);
});
