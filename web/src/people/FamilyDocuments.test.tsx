import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { apiGet } from '../api/client';

import { FamilyDocuments } from './FamilyDocuments';

vi.mock('../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const orgId = '0199a413-a221-7000-8000-000000000003';
const personId = '0199a413-a221-7000-8000-000000000004';
const documentsPath = `/people/orgs/${orgId}/${personId}/family-documents`;

function familyPayload(relationship: 'guardian' | 'self', age: number) {
  return {
    organizations: [
      {
        orgId,
        orgName: 'Northstar',
        people: [
          {
            personId,
            firstName: 'Avery',
            lastName: 'Athlete',
            age,
            relationship,
          },
        ],
      },
    ],
  };
}

function renderScreen(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[`/me/family/${orgId}/${personId}/documents`]}
      >
        <Routes>
          <Route
            path="/me/family/:orgId/:personId/documents"
            element={<FamilyDocuments />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockDocumentsView(
  relationship: 'guardian' | 'self',
  age: number,
): void {
  vi.mocked(apiGet).mockImplementation((path) => {
    if (path === '/people/me/family')
      return Promise.resolve(familyPayload(relationship, age));
    if (path === documentsPath) return Promise.resolve({ items: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

it('keeps a teen self profile read-only and skips the protected documents API', async () => {
  mockDocumentsView('self', 16);
  renderScreen();

  expect(
    await screen.findByText(
      'A verified guardian manages documents for this profile.',
    ),
  ).toBeTruthy();
  expect(screen.queryByLabelText('Choose a PDF, JPEG, or PNG file')).toBeNull();
  expect(apiGet).not.toHaveBeenCalledWith(documentsPath, expect.anything());
});

it('lets a verified guardian list and upload family documents', async () => {
  mockDocumentsView('guardian', 16);
  renderScreen();

  expect(
    await screen.findByLabelText('Choose a PDF, JPEG, or PNG file'),
  ).toBeTruthy();
  expect(await screen.findByText('No documents have been added.')).toBeTruthy();
  await waitFor(() => {
    expect(apiGet).toHaveBeenCalledWith(documentsPath, expect.anything());
  });
});

it('lets an adult self profile list and upload its own documents', async () => {
  mockDocumentsView('self', 19);
  renderScreen();

  expect(
    await screen.findByLabelText('Choose a PDF, JPEG, or PNG file'),
  ).toBeTruthy();
  expect(await screen.findByText('No documents have been added.')).toBeTruthy();
  await waitFor(() => {
    expect(apiGet).toHaveBeenCalledWith(documentsPath, expect.anything());
  });
});
