import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet } from '../../api/client';

import { YearEndStatementScreen } from './YearEndStatementScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn() }));

const orgId = '0199a413-a221-7000-8000-000000000003';
beforeEach(() => {
  vi.mocked(apiGet).mockReset();
});
afterEach(cleanup);

describe('payer year-end statement screen', () => {
  it('shows recorded donation and refund flows for a selected year', async () => {
    const current = new Date().getFullYear();
    const response = (year: number) => ({
      orgId,
      orgName: 'Lakeside Club',
      year,
      timezone: 'America/Chicago',
      currency: 'USD',
      paymentCount: 2,
      totalPaidCents: 1500,
      refundedToOriginalCents: 100,
      movedToCreditCents: 50,
      donationPaidCents: 500,
      donationRefundedCents: 25,
    });
    vi.mocked(apiGet)
      .mockResolvedValueOnce(response(current))
      .mockResolvedValueOnce(response(2025));
    render(<YearEndStatementScreen orgId={orgId} orgName="Lakeside Club" />);
    expect(await screen.findByText('$15.00')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Calendar year'), {
      target: { value: '2025' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show statement' }));
    await waitFor(() => {
      expect(apiGet).toHaveBeenLastCalledWith(
        `/finance/orgs/${orgId}/me/statements/2025`,
        expect.anything(),
      );
    });
    expect(await screen.findByText('$5.00')).toBeTruthy();
    expect(screen.getByText('$0.25')).toBeTruthy();
  });
});
