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

import { MyRegistrationsScreen } from './MyRegistrationsScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../PortalShell', () => ({
  PortalShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const orgId = '0199a413-a221-7000-8000-000000000011';
const registrationId = '0199a413-a221-7000-8000-000000000012';
const preview = {
  registrationId,
  refundCents: 1200,
  refundBps: 5000,
  requiresApproval: false,
  approvalThresholdCents: 10_000,
  paidCents: 2400,
};

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
  vi.mocked(apiGet).mockImplementation((path) => {
    if (path.endsWith('/me/registrations'))
      return Promise.resolve({
        registrations: [
          {
            id: registrationId,
            personId: '0199a413-a221-7000-8000-000000000013',
            personName: 'Maya One',
            programId: '0199a413-a221-7000-8000-000000000014',
            programName: 'Fall Soccer',
            offeringId: '0199a413-a221-7000-8000-000000000015',
            offeringName: 'Player',
            status: 'confirmed',
            statusReason: null,
            checkoutId: null,
            invoiceId: null,
            approvalPaymentDueAt: null,
            createdAt: '2026-09-20T12:00:00.000Z',
          },
        ],
      });
    if (path.endsWith('/me/waitlist')) return Promise.resolve({ entries: [] });
    if (path.endsWith('/cancellation-preview')) return Promise.resolve(preview);
    return Promise.reject(new Error(`Unexpected GET ${path}`));
  });
  vi.mocked(apiPost).mockResolvedValue({
    status: 'withdrawn',
    refundProposal: preview,
  });
});

afterEach(cleanup);

describe('family registration list', () => {
  it('shows the current refund preview before confirming cancellation', async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <MyRegistrationsScreen orgId={orgId} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Fall Soccer')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Register Maya One again' })
        .getAttribute('href'),
    ).toBe(
      `/portal/orgs/${orgId}/register?participantId=0199a413-a221-7000-8000-000000000013`,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Review cancellation' }),
    );
    expect(await screen.findByText(/Estimated refund:/)).toBeTruthy();
    expect(screen.getByText(/\$12\.00/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm cancellation' }),
    );

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        `/registration/orgs/${orgId}/me/registrations/${registrationId}/cancel`,
        { reason: 'Family requested cancellation' },
        expect.anything(),
        expect.stringMatching(/^[0-9a-f-]{36}$/i),
      );
    });
  });
});
