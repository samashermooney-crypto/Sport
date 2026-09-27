import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet } from '../../api/client';

import { InvoiceBalanceScreen } from './InvoiceBalanceScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn() }));

const invoice = {
  id: '0199a413-a221-7000-8000-000000000001',
  number: 2,
  status: 'partially_paid',
  source: 'checkout',
  issuedAt: '2026-09-27T12:00:00.000Z',
  dueOn: '2026-10-27',
  totalCents: 2500,
  paidCents: 1000,
  refundedCents: 0,
  creditAppliedCents: 0,
  balanceCents: 1500,
};

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
});
afterEach(cleanup);

describe('payer invoice balance screen', () => {
  it('shows billed cents and loads the next page through the account feed', async () => {
    vi.mocked(apiGet)
      .mockResolvedValueOnce({ invoices: [invoice], nextBeforeNumber: 2 })
      .mockResolvedValueOnce({
        invoices: [
          {
            ...invoice,
            id: '0199a413-a221-7000-8000-000000000002',
            number: 1,
            balanceCents: 0,
            status: 'paid',
          },
        ],
        nextBeforeNumber: null,
      });
    render(
      <InvoiceBalanceScreen
        orgId="0199a413-a221-7000-8000-000000000003"
        orgName="Lakeside Club"
      />,
    );
    expect(await screen.findByText('Invoice #2')).toBeTruthy();
    expect(screen.getByText('$15.00')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Load more invoices',
      }),
    );
    expect(await screen.findByText('Invoice #1')).toBeTruthy();
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith(
        '/finance/orgs/0199a413-a221-7000-8000-000000000003/me/invoices?beforeNumber=2',
        expect.anything(),
      );
    });
  });
});
