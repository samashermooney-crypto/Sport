import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { RegistrationStaffScreen } from './RegistrationStaffScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const orgId = '0199a413-a221-7000-8000-000000000011';
const registrationId = '0199a413-a221-7000-8000-000000000012';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockImplementation((path) =>
    Promise.resolve(
      path.endsWith('/team-entries')
        ? { entries: [] }
        : {
            registrations: [
              {
                id: registrationId,
                personId: '0199a413-a221-7000-8000-000000000013',
                personName: 'Maya One',
                householdId: '0199a413-a221-7000-8000-000000000014',
                programId: '0199a413-a221-7000-8000-000000000015',
                programName: 'Fall Soccer',
                offeringId: '0199a413-a221-7000-8000-000000000016',
                offeringName: 'Player',
                status: 'pending_approval',
                statusReason: null,
                checkoutId: null,
                invoiceId: null,
                approvalPaymentDueAt: null,
                createdAt: '2026-09-20T12:00:00.000Z',
              },
            ],
          },
    ),
  );
  vi.mocked(apiPost).mockResolvedValue({
    status: 'pending_payment',
    paymentDueAt: null,
  });
});

afterEach(cleanup);

it('approves a queued registration with a stable UUID idempotency key', async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RegistrationStaffScreen orgId={orgId} />
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

  await waitFor(() => {
    expect(apiPost).toHaveBeenCalledWith(
      `/registration/orgs/${orgId}/registrations/${registrationId}/approval`,
      { decision: 'approved' },
      expect.anything(),
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    );
  });
  expect((await screen.findByRole('status')).textContent).toContain(
    'Registration approved.',
  );
});

it('approves a scoped external team entry from the staff queue', async () => {
  const teamEntryId = '0199a413-a221-7000-8000-000000000017';
  vi.mocked(apiGet).mockImplementation((path) =>
    Promise.resolve(
      path.endsWith('/team-entries')
        ? {
            entries: [
              {
                id: teamEntryId,
                teamName: 'Northside United',
                programId: '0199a413-a221-7000-8000-000000000015',
                programName: 'Fall Soccer',
                divisionId: '0199a413-a221-7000-8000-000000000016',
                divisionName: 'U16',
                offeringId: '0199a413-a221-7000-8000-000000000018',
                offeringName: 'External team entry',
                captainPersonId: '0199a413-a221-7000-8000-000000000019',
                status: 'pending_approval',
                seedHint: null,
                createdAt: '2026-09-20T12:00:00.000Z',
                inviteCount: 4,
              },
            ],
          }
        : { registrations: [] },
    ),
  );
  vi.mocked(apiPost).mockResolvedValue({ status: 'accepted' });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RegistrationStaffScreen orgId={orgId} />
    </QueryClientProvider>,
  );

  expect(await screen.findByText('Northside United')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve team' }));

  await waitFor(() => {
    expect(apiPost).toHaveBeenCalledWith(
      `/registration/orgs/${orgId}/team-entries/${teamEntryId}/approval`,
      { decision: 'approved' },
      expect.anything(),
    );
  });
  expect((await screen.findByRole('status')).textContent).toContain(
    'Team entry approved.',
  );
});

it('loads scoped registration and uniform size reports for staff', async () => {
  vi.mocked(apiGet).mockImplementation((path) =>
    Promise.resolve(
      path.endsWith('/team-entries')
        ? { entries: [] }
        : path.includes('/reports/registrations')
          ? {
              filters: {},
              total: 1,
              truncated: false,
              registrations: [
                {
                  registrationId,
                  participantName: 'Maya One',
                  programId: '0199a413-a221-7000-8000-000000000015',
                  programName: 'Fall Soccer',
                  divisionId: '0199a413-a221-7000-8000-000000000016',
                  divisionName: 'Youth',
                  offeringId: '0199a413-a221-7000-8000-000000000017',
                  offeringName: 'Player',
                  teamName: null,
                  status: 'confirmed',
                  registeredAt: '2026-09-20T12:00:00.000Z',
                },
              ],
            }
          : path.includes('/reports/uniform-sizes')
            ? {
                filters: {},
                items: [
                  {
                    programId: '0199a413-a221-7000-8000-000000000015',
                    programName: 'Fall Soccer',
                    divisionId: '0199a413-a221-7000-8000-000000000016',
                    divisionName: 'Youth',
                    teamName: null,
                    addOnKey: 'uniform-kit',
                    addOnName: 'Uniform kit',
                    size: 'Youth Medium',
                    quantity: 2,
                    registrations: 1,
                  },
                ],
              }
            : { registrations: [] },
    ),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RegistrationStaffScreen orgId={orgId} />
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Load reports' }));

  expect((await screen.findAllByText('Fall Soccer')).length).toBeGreaterThan(0);
  expect(await screen.findByText('Uniform kit')).toBeTruthy();
  expect(screen.getByText('Youth Medium')).toBeTruthy();
});
