import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../api/client';

import { ImportsConsole } from './ImportsConsole';

vi.mock('../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('./PeopleConsole', async () => {
  const React = await import('react');
  return {
    PeopleShell: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
  };
});

const orgId = '11111111-1111-4111-8111-111111111111';
const batchId = '22222222-2222-4222-8222-222222222222';
const batch = {
  id: batchId,
  kind: 'people',
  filename: 'roster.csv',
  status: 'preview',
  stats: { total: 1, create: 1, update: 0, merge: 0, skip: 0, invalid: 0 },
  createdBy: '33333333-3333-4333-8333-333333333333',
  createdAt: '2026-09-27T10:00:00.000Z',
  committedAt: null,
  rolledBackAt: null,
};

function renderScreen(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/console/orgs/${orgId}/imports`]}>
        <Routes>
          <Route
            path="/console/orgs/:orgId/imports"
            element={<ImportsConsole />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockResolvedValue({ items: [] });
});
afterEach(cleanup);

it('previews, commits, and rolls back a mapped CSV batch', async () => {
  const csv = 'First Name,Last Name,DOB\nAva,Mooney,2012-04-03';
  const file = new File([csv], 'roster.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', {
    value: () => Promise.resolve(csv),
  });
  vi.mocked(apiPost)
    .mockResolvedValueOnce({
      batch,
      rows: [
        {
          rowNumber: 2,
          action: 'create',
          issues: [],
          normalized: {
            firstName: 'Ava',
            lastName: 'Mooney',
            dateOfBirth: '2012-04-03',
          },
        },
      ],
    })
    .mockResolvedValueOnce({ ...batch, status: 'committed' })
    .mockResolvedValueOnce({ ...batch, status: 'rolled_back' });

  renderScreen();
  fireEvent.change(await screen.findByLabelText(/CSV or XLSX file/), {
    target: { files: [file] },
  });
  expect(await screen.findByText('Selected: roster.csv')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));
  expect(
    await screen.findByRole('heading', { name: 'Batch preview' }),
  ).toBeTruthy();
  expect(screen.getByRole('cell', { name: '2' })).toBeTruthy();
  expect(screen.getByRole('cell', { name: 'create' })).toBeTruthy();
  const previewRequest = vi.mocked(apiPost).mock.calls[0];
  if (!previewRequest) throw new Error('Preview request was not made');
  expect(previewRequest[0]).toBe(`/imports/orgs/${orgId}/batches`);
  const previewBody = previewRequest[1];
  if (typeof previewBody !== 'object' || previewBody === null)
    throw new Error('Preview request body is not an object');
  const previewBodyRecord = previewBody as Record<string, unknown>;
  expect(previewBodyRecord['kind']).toBe('people');
  expect(previewBodyRecord['filename']).toBe('roster.csv');
  expect(previewBodyRecord['content']).toBe(csv);
  const mapping = previewBodyRecord['mapping'];
  if (typeof mapping !== 'object' || mapping === null)
    throw new Error('Preview mapping is not an object');
  const mappingRecord = mapping as Record<string, unknown>;
  expect(mappingRecord['firstName']).toBe('First Name');
  expect(mappingRecord['lastName']).toBe('Last Name');
  expect(mappingRecord['dateOfBirth']).toBe('DOB');

  fireEvent.click(screen.getByRole('button', { name: 'Commit valid rows' }));
  await waitFor(() => {
    expect(screen.getByText(/roster\.csv · 1 rows · committed/)).toBeTruthy();
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Roll back untouched rows' }),
  );
  await waitFor(() => {
    expect(screen.getByText(/roster\.csv · 1 rows · rolled_back/)).toBeTruthy();
  });
  expect(apiPost).toHaveBeenNthCalledWith(
    2,
    `/imports/orgs/${orgId}/batches/${batchId}/commit`,
    {},
    expect.anything(),
  );
  expect(apiPost).toHaveBeenNthCalledWith(
    3,
    `/imports/orgs/${orgId}/batches/${batchId}/rollback`,
    {},
    expect.anything(),
  );
});
