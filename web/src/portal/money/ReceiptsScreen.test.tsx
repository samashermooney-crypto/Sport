import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { apiGet } from '../../api/client';

import { ReceiptsScreen } from './ReceiptsScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn() }));
const orgId = '11111111-1111-4111-8111-111111111111';
const paymentId = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiGet).mockResolvedValue({
    receipts: [
      {
        paymentId,
        amountCents: 1250,
        method: 'card',
        succeededAt: '2026-09-27T12:00:00.000Z',
        receiptNumber: 3,
        invoiceNumbers: [10],
      },
    ],
    nextCursor: null,
  });
});

it('links each settled payment to its scoped PDF receipt', async () => {
  render(<ReceiptsScreen orgId={orgId} orgName="Club" />);
  expect(await screen.findByText('Receipt #3')).toBeTruthy();
  expect(screen.getByText('$12.50')).toBeTruthy();
  expect(
    screen
      .getByRole('link', { name: 'Download receipt PDF' })
      .getAttribute('href'),
  ).toBe(`/api/v1/finance/orgs/${orgId}/me/payments/${paymentId}/receipt.pdf`);
});
