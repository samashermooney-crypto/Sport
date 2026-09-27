import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { TeamEntriesScreen } from './TeamEntriesScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../PortalShell', () => ({
  PortalShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const orgId = '0199a413-a221-7000-8000-000000000011';
const offeringId = '0199a413-a221-7000-8000-000000000012';
const captainPersonId = '0199a413-a221-7000-8000-000000000013';
const entryId = '0199a413-a221-7000-8000-000000000014';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockImplementation((path) =>
    Promise.resolve(
      path.endsWith('/team-entry-options')
        ? {
            offerings: [
              {
                offeringId,
                programName: 'Fall Soccer',
                divisionName: 'U16',
                offeringName: 'External team',
                requiresApproval: true,
              },
            ],
            captains: [{ personId: captainPersonId, name: 'Jordan Captain' }],
          }
        : { entries: [] },
    ),
  );
  vi.mocked(apiPost).mockResolvedValue({
    id: entryId,
    teamName: 'Northside United',
    programId: '0199a413-a221-7000-8000-000000000015',
    programName: 'Fall Soccer',
    divisionId: '0199a413-a221-7000-8000-000000000016',
    divisionName: 'U16',
    offeringId,
    offeringName: 'External team',
    captainPersonId,
    status: 'pending_approval',
    seedHint: null,
    createdAt: '2026-09-20T12:00:00.000Z',
    inviteCount: 0,
  });
});

afterEach(cleanup);

it('registers a verified adult captain with a stable request key', async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <TeamEntriesScreen orgId={orgId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  fireEvent.change(await screen.findByLabelText('Program and division'), {
    target: { value: offeringId },
  });
  fireEvent.change(screen.getByLabelText('Captain'), {
    target: { value: captainPersonId },
  });
  fireEvent.change(screen.getByLabelText('Team name'), {
    target: { value: 'Northside United' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Register team' }));

  await waitFor(() => {
    expect(apiPost).toHaveBeenCalledWith(
      `/registration/orgs/${orgId}/team-entries`,
      { offeringId, captainPersonId, teamName: 'Northside United' },
      expect.anything(),
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
    );
  });
  expect(
    await screen.findByText(
      'Team registered. The organization will review it.',
    ),
  ).toBeTruthy();
});
