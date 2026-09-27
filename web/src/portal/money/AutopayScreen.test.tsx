import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { AutopayScreen } from './AutopayScreen';

vi.mock('../../api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));
const orgId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const authorization = {
  id,
  invoiceId: '33333333-3333-4333-8333-333333333333',
  invoiceNumber: 42,
  paymentMethodId: '44444444-4444-4444-8444-444444444444',
  methodType: 'card',
  last4: '4242',
  authorizedAt: '2026-09-27T12:00:00.000Z',
  revokedAt: null,
  mandateTextVersion: 'mandate-v1',
  futureInstallments: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockResolvedValue({ authorizations: [authorization] });
  vi.mocked(apiPost).mockResolvedValue({
    revoked: true,
    stoppedInstallments: 2,
  });
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
});

it('lets the payer stop autopay and refreshes the mandate state', async () => {
  render(<AutopayScreen orgId={orgId} orgName="Club" />);
  expect(await screen.findByText('Invoice #42')).toBeTruthy();
  vi.mocked(apiGet).mockResolvedValue({
    authorizations: [
      {
        ...authorization,
        revokedAt: '2026-09-27T12:05:00.000Z',
        futureInstallments: 0,
      },
    ],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Stop autopay' }));
  await waitFor(() => {
    expect(apiPost).toHaveBeenCalledWith(
      `/finance/orgs/${orgId}/me/autopay/${id}/revoke`,
      {},
      expect.anything(),
    );
  });
  expect(await screen.findByText('Autopay stopped')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Stop autopay' })).toBeNull();
});
