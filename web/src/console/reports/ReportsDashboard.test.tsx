import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
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
      if (url.endsWith('/datasets')) {
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
          ],
        };
      } else {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a serialized report preview request');
        }
        const definition = JSON.parse(init.body) as {
          definition: { dataset: string };
        };
        if (definition.definition.dataset === 'registrations') {
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
          status: 200,
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
  expect(
    screen.queryByRole('heading', { name: 'Revenue by program' }),
  ).toBeNull();
  const previews = fetcher.mock.calls.filter(([input]) =>
    requestUrl(input).endsWith('/reports/preview'),
  );
  expect(previews).toHaveLength(3);
});
