import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { TeamEntryInviteScreen } from './TeamEntryInviteScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../PortalShell', () => ({
  PortalShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const orgId = '0199a413-a221-7000-8000-000000000011';
const token = 'a'.repeat(43);
const checkoutId = '0199a413-a221-7000-8000-000000000012';
const personId = '0199a413-a221-7000-8000-000000000013';
const householdId = '0199a413-a221-7000-8000-000000000014';

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockImplementation((path) =>
    Promise.resolve(
      path.includes('/team-entry-invites/')
        ? {
            entryId: '0199a413-a221-7000-8000-000000000015',
            teamName: 'Northside United',
            programName: 'Fall Soccer',
            divisionName: 'U16',
            email: 'parent@example.invalid',
            status: 'pending',
            expiresAt: '2026-10-04T12:00:00.000Z',
          }
        : {
            people: [
              {
                personId,
                householdId,
                name: 'Alex Player',
                householdName: 'Player family',
              },
            ],
          },
    ),
  );
  vi.mocked(apiPost).mockResolvedValue({ checkoutId });
});

afterEach(cleanup);

it('accepts for a selected family member and opens normal checkout requirements', async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter
        initialEntries={[`/portal/orgs/${orgId}/team-entry-invites/${token}`]}
      >
        <TeamEntryInviteScreen orgId={orgId} token={token} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText('Northside United')).toBeTruthy();
  fireEvent.change(
    await screen.findByLabelText('Register this family member'),
    {
      target: { value: `${personId}:${householdId}` },
    },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Accept and continue' }));

  await waitFor(() => {
    expect(apiPost).toHaveBeenCalledWith(
      `/registration/orgs/${orgId}/team-entry-invites/${token}/accept`,
      { personId, householdId },
      expect.anything(),
    );
  });
  await waitFor(() => {
    expect(screen.getByTestId('location').textContent).toBe(
      `/portal/orgs/${orgId}/register/checkouts/${checkoutId}/requirements`,
    );
  });
});
