import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { ReportBuilder } from './ReportBuilder';

const orgId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';

afterEach(() => vi.unstubAllGlobals());

it('limits reports to available role columns and previews the selected definition', async () => {
  let previewRequestBody = '';
  const fetcher = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/reports/preview') && typeof init?.body === 'string')
        previewRequestBody = init.body;
      let result: unknown;
      if (url.endsWith('/datasets')) {
        result = {
          items: [
            {
              key: 'registrations',
              label: 'Registrations',
              description: 'Registration records',
              available: true,
              columns: [
                {
                  key: 'id',
                  label: 'Registration ID',
                  type: 'text',
                  tier: 'internal',
                },
                {
                  key: 'status',
                  label: 'Status',
                  type: 'enum',
                  tier: 'internal',
                },
                {
                  key: 'created_at',
                  label: 'Registered at',
                  type: 'datetime',
                  tier: 'internal',
                },
                {
                  key: 'person_gender',
                  label: 'Participant gender',
                  type: 'enum',
                  tier: 'sensitive',
                },
                {
                  key: 'household_postal_code',
                  label: 'Household ZIP/postal code',
                  type: 'text',
                  tier: 'sensitive',
                },
              ],
            },
            {
              key: 'payouts',
              label: 'Payouts',
              description: 'Settlement payouts',
              available: true,
              columns: [
                {
                  key: 'status',
                  label: 'Status',
                  type: 'enum',
                  tier: 'internal',
                },
                {
                  key: 'amount_cents',
                  label: 'Amount',
                  type: 'money',
                  tier: 'sensitive',
                },
              ],
            },
            {
              key: 'retention_cohorts',
              label: 'Year-over-year retention',
              description: 'Unique confirmed participant retention',
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
      } else if (url.endsWith('/saved-reports')) {
        result = { items: [] };
      } else if (url.endsWith('/report-schedules')) {
        result = { items: [] };
      } else if (url.endsWith('/auth/me')) {
        result = {
          id: accountId,
          email: 'owner@example.test',
          firstName: 'Org',
          lastName: 'Owner',
          locale: 'en',
          mfaEnabled: true,
          sessionId: '33333333-3333-4333-8333-333333333333',
          client: 'web',
        };
      } else {
        result = {
          columns: [{ key: 'status', label: 'Status', type: 'enum' }],
          rows: [['open']],
          truncated: false,
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

  render(<ReportBuilder orgId={orgId} />);
  expect(
    await screen.findByRole('heading', { name: 'Build a report' }),
  ).toBeTruthy();
  expect(screen.getAllByText('Internal')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Registration pace' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Preview report' }),
  );
  expect(await screen.findByText('open')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledWith(
    `/api/v1/reports/orgs/${orgId}/reports/preview`,
    expect.objectContaining({ method: 'POST' }),
  );
  expect(previewRequestBody).toContain('"dataset":"registrations"');
  expect(previewRequestBody).toContain('"timeGrain":"week"');

  fireEvent.click(
    screen.getByRole('button', { name: 'Payouts by settlement status' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview report' }));
  await screen.findByText('open');
  expect(previewRequestBody).toContain('"dataset":"payouts"');
  expect(previewRequestBody).toContain('"amount_cents"');

  fireEvent.click(
    screen.getByRole('button', { name: 'Registration by gender' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview report' }));
  await screen.findByText('open');
  expect(previewRequestBody).toContain('"person_gender"');

  fireEvent.click(
    screen.getByRole('button', { name: 'Registration by ZIP/postal code' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview report' }));
  await screen.findByText('open');
  expect(previewRequestBody).toContain('"household_postal_code"');

  fireEvent.click(
    screen.getByRole('button', { name: 'Retention year over year' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview report' }));
  await screen.findByText('open');
  expect(previewRequestBody).toContain('"dataset":"retention_cohorts"');
  expect(previewRequestBody).toContain('"retention_rate_percent"');
});
