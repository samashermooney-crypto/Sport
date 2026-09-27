import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { CreditBalanceScreen } from './CreditBalanceScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const orgId = '0199a413-a221-7000-8000-000000000003';
const householdId = '0199a413-a221-7000-8000-000000000004';
beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
});
afterEach(cleanup);

describe('payer credit balance screen', () => {
  it('shows only payer-returned available cents for the selected organization', async () => {
    vi.mocked(apiGet)
      .mockResolvedValueOnce({
        orgId,
        accountBalanceCents: 700,
        householdBalances: [
          { householdId, householdName: 'River family', balanceCents: 500 },
        ],
        totalAvailableCents: 1200,
        asOfLocalDate: '2026-09-27',
      })
      .mockResolvedValueOnce({ invoices: [], nextBeforeNumber: null });
    render(<CreditBalanceScreen orgId={orgId} orgName="Lakeside Club" />);
    expect(await screen.findByText('$12.00')).toBeTruthy();
    expect(screen.getByText('$7.00')).toBeTruthy();
    expect(screen.getByText('$5.00')).toBeTruthy();
    expect(screen.getByText('River family')).toBeTruthy();
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith(
        `/finance/orgs/${orgId}/me/credits`,
        expect.anything(),
      );
    });
  });

  it('applies the available amount to a selected invoice with a stable key', async () => {
    const invoiceId = '0199a413-a221-7000-8000-000000000005';
    vi.mocked(apiGet)
      .mockResolvedValueOnce({
        orgId,
        accountBalanceCents: 700,
        householdBalances: [],
        totalAvailableCents: 700,
        asOfLocalDate: '2026-09-27',
      })
      .mockResolvedValueOnce({
        invoices: [
          { id: invoiceId, number: 12, balanceCents: 500, status: 'open' },
        ],
        nextBeforeNumber: null,
      })
      .mockResolvedValueOnce({
        orgId,
        accountBalanceCents: 200,
        householdBalances: [],
        totalAvailableCents: 200,
        asOfLocalDate: '2026-09-27',
      })
      .mockResolvedValueOnce({ invoices: [], nextBeforeNumber: null });
    vi.mocked(apiPost).mockResolvedValue({ applied: true });
    render(<CreditBalanceScreen orgId={orgId} orgName="Lakeside Club" />);
    const select = await screen.findByLabelText('Invoice');
    fireEvent.change(select, { target: { value: invoiceId } });
    expect(screen.getByText('$5.00 will be applied.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply credit' }));
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        `/finance/orgs/${orgId}/me/credits/apply`,
        { recipient: { kind: 'account' }, invoiceId, amountCents: 500 },
        expect.anything(),
        expect.stringMatching(/^[0-9a-f-]{36}$/),
      );
    });
    expect(
      await screen.findByText('Credit applied to the invoice.'),
    ).toBeTruthy();
  });
});
