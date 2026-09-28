import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { ReportsDashboard } from './ReportsDashboard';

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

it('renders role-permitted organization visuals with accessible value tables', async () => {
  const fetcher = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      let result: unknown;
      let status = 200;
      if (url.endsWith('/board-report.pdf')) {
        status = 401;
        result = {
          error: {
            code: 'REAUTH_REQUIRED',
            message: 'Recent sign-in is required for financial totals.',
          },
        };
      } else if (url.endsWith('/datasets')) {
        result = {
          items: [
            {
              key: 'registrations',
              label: 'Registrations',
              description: 'Program registrations',
              available: true,
              columns: [
                { key: 'id', label: 'ID', type: 'text', tier: 'internal' },
                {
                  key: 'program_name',
                  label: 'Program',
                  type: 'text',
                  tier: 'internal',
                },
                {
                  key: 'created_at',
                  label: 'Registered at',
                  type: 'datetime',
                  tier: 'internal',
                },
              ],
            },
            {
              key: 'invoice_lines',
              label: 'Invoice lines',
              description: 'Line items',
              available: false,
              columns: [
                {
                  key: 'program_name',
                  label: 'Program',
                  type: 'text',
                  tier: 'internal',
                },
              ],
            },
            {
              key: 'invoices',
              label: 'Invoices',
              description: 'Invoice headers',
              available: true,
              columns: [
                {
                  key: 'aging_bucket',
                  label: 'Aging bucket',
                  type: 'enum',
                  tier: 'internal',
                },
                {
                  key: 'balance_cents',
                  label: 'Balance',
                  type: 'money',
                  tier: 'sensitive',
                },
              ],
            },
            {
              key: 'retention_cohorts',
              label: 'Retention cohorts',
              description: 'Year-over-year retention',
              available: true,
              columns: [
                'current_year',
                'previous_year',
                'previous_participants',
                'retained_participants',
                'retention_rate_percent',
              ].map((key) => ({
                key,
                label: key,
                type: 'number',
                tier: 'internal',
              })),
            },
            {
              key: 'credentials',
              label: 'Credentials',
              description: 'Credential status',
              available: true,
              columns: [
                {
                  key: 'id',
                  label: 'Credential ID',
                  type: 'text',
                  tier: 'internal',
                },
                {
                  key: 'status',
                  label: 'Status',
                  type: 'enum',
                  tier: 'internal',
                },
              ],
            },
          ],
        };
      } else {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a serialized report preview request');
        }
        const definition = JSON.parse(init.body) as {
          definition: { dataset: string; timeGrain?: string };
        };
        if (
          definition.definition.dataset === 'registrations' &&
          definition.definition.timeGrain === 'month'
        ) {
          result = {
            columns: [
              { key: 'created_at', label: 'Registered at', type: 'datetime' },
              { key: 'count_id', label: 'Registrations', type: 'number' },
            ],
            rows: [['2025-01-01T00:00:00.000Z', 3]],
            truncated: false,
          };
        } else if (definition.definition.dataset === 'registrations') {
          result = {
            columns: [
              { key: 'program_name', label: 'Program', type: 'text' },
              { key: 'count_id', label: 'Registrations', type: 'number' },
            ],
            rows: [['Soccer', 4]],
            truncated: false,
          };
        } else if (definition.definition.dataset === 'invoices') {
          result = {
            columns: [
              { key: 'aging_bucket', label: 'Aging bucket', type: 'enum' },
              { key: 'sum_balance_cents', label: 'Balance', type: 'money' },
            ],
            rows: [['1–30 days', 150000]],
            truncated: false,
          };
        } else if (definition.definition.dataset === 'credentials') {
          result = {
            columns: [
              { key: 'status', label: 'Status', type: 'enum' },
              { key: 'count_id', label: 'Credentials', type: 'number' },
            ],
            rows: [
              ['verified', 3],
              ['pending_review', 1],
            ],
            truncated: false,
          };
        } else {
          result = {
            columns: [
              { key: 'current_year', label: 'Current year', type: 'number' },
              {
                key: 'retention_rate_percent',
                label: 'Retention rate (%)',
                type: 'number',
              },
            ],
            rows: [[2026, 50]],
            truncated: false,
          };
        }
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
      <ReportsDashboard orgId={orgId} />
    </QueryClientProvider>,
  );

  expect(
    await screen.findByRole('heading', { name: 'Organization overview' }),
  ).toBeTruthy();
  const paceTable = await screen.findByRole('table', {
    name: 'Registration pace (past 12 months) data',
  });
  expect(
    within(paceTable).getByRole('rowheader', { name: 'Jan 2025' }),
  ).toBeTruthy();
  const registrationTable = await screen.findByRole('table', {
    name: 'Registrations by program data',
  });
  expect(
    within(registrationTable).getByRole('rowheader', { name: 'Soccer' }),
  ).toBeTruthy();
  const receivablesTable = await screen.findByRole('table', {
    name: 'Aging receivables data',
  });
  expect(
    within(receivablesTable).getByRole('cell', { name: '$1,500.00' }),
  ).toBeTruthy();
  const retentionTable = await screen.findByRole('table', {
    name: 'Participant retention year over year data',
  });
  expect(
    within(retentionTable).getByRole('cell', { name: '50.0%' }),
  ).toBeTruthy();
  const complianceTable = await screen.findByRole('table', {
    name: 'Credential compliance data',
  });
  expect(
    within(complianceTable).getByRole('cell', { name: '75.0%' }),
  ).toBeTruthy();
  expect(
    within(complianceTable).getByRole('cell', { name: '25.0%' }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('heading', { name: 'Revenue by program' }),
  ).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Money' }));
  expect(
    await screen.findByRole('heading', { name: 'Money overview' }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('heading', {
      name: 'Registration pace (past 12 months)',
    }),
  ).toBeNull();
  expect(
    await screen.findByRole('heading', { name: 'Aging receivables' }),
  ).toBeTruthy();

  const previews = fetcher.mock.calls.filter(([input]) =>
    requestUrl(input).endsWith('/reports/preview'),
  );
  expect(previews).toHaveLength(6);

  fireEvent.click(screen.getByRole('button', { name: 'Download board PDF' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Recent sign-in is required for financial totals.',
  );
});
