import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { apiGet } from '../api/client';

import { FamilyMedical } from './FamilyMedical';

vi.mock('../api/client', () => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn(),
}));

const orgId = '0199a413-a221-7000-8000-000000000003';
const personId = '0199a413-a221-7000-8000-000000000004';

function familyPayload(relationship: 'guardian' | 'self') {
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
            age: 16,
            relationship,
          },
        ],
      },
    ],
  };
}

function renderScreen(
  path: string,
  cachedRelationship?: 'guardian' | 'self',
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (cachedRelationship)
    client.setQueryData(
      ['people', 'me', 'family'],
      familyPayload(cachedRelationship),
    );
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/me/family/:orgId/:personId/medical"
            element={<FamilyMedical />}
          />
          <Route
            path="/console/orgs/:orgId/people/:personId/medical"
            element={<FamilyMedical />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockMedicalView(relationship: 'guardian' | 'self'): void {
  vi.mocked(apiGet).mockImplementation((path) => {
    if (path === '/people/me/family')
      return Promise.resolve(familyPayload(relationship) as never);
    if (path === `/people/orgs/${orgId}/${personId}/medical`)
      return Promise.resolve({
        personId,
        version: 1,
        visibility: 'flags_only',
        canEdit: false,
        onFile: true,
        allergies: null,
        allergyFlags: [],
        conditions: null,
        medications: null,
        physicianName: null,
        physicianPhone: null,
        insuranceCarrier: null,
        insurancePolicy: null,
        notes: null,
      } as never);
    if (path === `/people/orgs/${orgId}/${personId}/emergency-contacts`)
      return Promise.resolve({ items: [], canEdit: true } as never);
    if (path === `/people/orgs/${orgId}/${personId}/athlete-link`)
      return Promise.resolve({
        accountId: null,
        email: null,
        verifiedAt: null,
        age: 16,
      } as never);
    throw new Error(`Unexpected request: ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

it('does not request guardian-only athlete access for a self-linked athlete', async () => {
  mockMedicalView('self');
  renderScreen(`/me/family/${orgId}/${personId}/medical`);

  expect(
    await screen.findByText('No emergency contacts are on file.'),
  ).toBeTruthy();
  await waitFor(() => {
    expect(apiGet).toHaveBeenCalledWith('/people/me/family', expect.anything());
  });
  expect(apiGet).not.toHaveBeenCalledWith(
    `/people/orgs/${orgId}/${personId}/athlete-link`,
    expect.anything(),
  );
  expect(
    screen.queryByRole('heading', { name: 'Athlete account access' }),
  ).toBeNull();
});

it('does not trust a cached guardian relationship before refreshing the family', async () => {
  let resolveFamily!: (value: ReturnType<typeof familyPayload>) => void;
  const refreshedFamily = new Promise<ReturnType<typeof familyPayload>>(
    (resolve) => {
      resolveFamily = resolve;
    },
  );
  vi.mocked(apiGet).mockImplementation((path) => {
    if (path === '/people/me/family') return refreshedFamily;
    if (path === `/people/orgs/${orgId}/${personId}/medical`)
      return Promise.resolve({
        personId,
        version: 1,
        visibility: 'flags_only',
        canEdit: false,
        onFile: true,
        allergies: null,
        allergyFlags: [],
        conditions: null,
        medications: null,
        physicianName: null,
        physicianPhone: null,
        insuranceCarrier: null,
        insurancePolicy: null,
        notes: null,
      } as never);
    if (path === `/people/orgs/${orgId}/${personId}/emergency-contacts`)
      return Promise.resolve({ items: [], canEdit: true } as never);
    if (path === `/people/orgs/${orgId}/${personId}/athlete-link`)
      return Promise.resolve({
        accountId: null,
        email: null,
        verifiedAt: null,
        age: 16,
      } as never);
    throw new Error(`Unexpected request: ${path}`);
  });
  renderScreen(`/me/family/${orgId}/${personId}/medical`, 'guardian');

  expect(
    screen.queryByRole('heading', { name: 'Athlete account access' }),
  ).toBeNull();
  expect(apiGet).not.toHaveBeenCalledWith(
    `/people/orgs/${orgId}/${personId}/athlete-link`,
    expect.anything(),
  );

  resolveFamily(familyPayload('self'));
  expect(
    await screen.findByText('No emergency contacts are on file.'),
  ).toBeTruthy();
  expect(apiGet).not.toHaveBeenCalledWith(
    `/people/orgs/${orgId}/${personId}/athlete-link`,
    expect.anything(),
  );
});

it('loads athlete access controls for a verified guardian relationship', async () => {
  mockMedicalView('guardian');
  renderScreen(`/me/family/${orgId}/${personId}/medical`);

  expect(
    await screen.findByRole('heading', { name: 'Athlete account access' }),
  ).toBeTruthy();
  expect(apiGet).toHaveBeenCalledWith(
    `/people/orgs/${orgId}/${personId}/athlete-link`,
    expect.anything(),
  );
  expect(screen.getByText(/Invite this athlete to connect their own account/));
});

it('does not request family or athlete-link data from the staff view', async () => {
  vi.mocked(apiGet).mockImplementation((path) => {
    if (path === `/people/orgs/${orgId}/${personId}/medical`)
      return Promise.resolve({
        personId,
        version: 1,
        visibility: 'full',
        canEdit: false,
        onFile: true,
        allergies: null,
        allergyFlags: [],
        conditions: null,
        medications: null,
        physicianName: null,
        physicianPhone: null,
        insuranceCarrier: null,
        insurancePolicy: null,
        notes: null,
      } as never);
    if (path === `/people/orgs/${orgId}/${personId}/emergency-contacts`)
      return Promise.resolve({ items: [], canEdit: false } as never);
    throw new Error(`Unexpected request: ${path}`);
  });
  renderScreen(`/console/orgs/${orgId}/people/${personId}/medical`);

  expect(
    await screen.findByText('No emergency contacts are on file.'),
  ).toBeTruthy();
  expect(apiGet).not.toHaveBeenCalledWith(
    '/people/me/family',
    expect.anything(),
  );
  expect(apiGet).not.toHaveBeenCalledWith(
    `/people/orgs/${orgId}/${personId}/athlete-link`,
    expect.anything(),
  );
});
