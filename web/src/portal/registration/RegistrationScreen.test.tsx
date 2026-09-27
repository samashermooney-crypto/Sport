import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { RegistrationScreen } from './RegistrationScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../PortalShell', () => ({
  PortalShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const orgId = '0199a413-a221-7000-8000-000000000011';
const offeringId = '0199a413-a221-7000-8000-000000000012';
const personId = '0199a413-a221-7000-8000-000000000013';
const householdId = '0199a413-a221-7000-8000-000000000014';

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
  vi.mocked(apiGet).mockImplementation((path) =>
    Promise.resolve(
      path.endsWith('/catalog')
        ? {
            items: [
              {
                programId: '0199a413-a221-7000-8000-000000000015',
                programSlug: 'summer-soccer',
                programName: 'Summer Soccer',
                sport: 'Soccer',
                offeringId,
                offeringName: 'U12',
                divisionId: '0199a413-a221-7000-8000-000000000016',
                priceCents: 7500,
                status: 'full',
                waitlistEnabled: true,
              },
            ],
          }
        : {
            people: [
              {
                personId,
                householdId,
                name: 'Maya Family',
                householdName: 'Family',
              },
            ],
          },
    ),
  );
  vi.mocked(apiPost).mockResolvedValue({
    id: '0199a413-a221-7000-8000-000000000017',
    offeringId,
    offeringName: 'U12',
    programName: 'Summer Soccer',
    personId,
    personName: 'Maya Family',
    position: 1,
    status: 'waiting',
    checkoutId: null,
    offeredAt: null,
    offerExpiresAt: null,
  });
});

afterEach(cleanup);

describe('family registration discovery', () => {
  it('lets an eligible family member join a full offering waitlist', async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <RegistrationScreen orgId={orgId} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Full')).toBeTruthy();
    fireEvent.change(
      await screen.findByLabelText(
        'Participant for Summer Soccer · U12 waitlist',
      ),
      {
        target: { value: `${personId}:${householdId}` },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Join waitlist' }));

    expect(
      await screen.findByText('You are #1 on this waitlist.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        `/registration/orgs/${orgId}/me/waitlist`,
        { offeringId, personId, householdId },
        expect.anything(),
      );
    });
  });
});
