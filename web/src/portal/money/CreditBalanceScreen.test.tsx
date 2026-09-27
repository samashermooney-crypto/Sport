import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet } from '../../api/client';

import { CreditBalanceScreen } from './CreditBalanceScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn() }));

const orgId = '0199a413-a221-7000-8000-000000000003';
const householdId = '0199a413-a221-7000-8000-000000000004';
beforeEach(() => {
  vi.mocked(apiGet).mockReset();
});
afterEach(cleanup);

describe('payer credit balance screen', () => {
  it('shows only payer-returned available cents for the selected organization', async () => {
    vi.mocked(apiGet).mockResolvedValue({
      orgId,
      accountBalanceCents: 700,
      householdBalances: [
        { householdId, householdName: 'River family', balanceCents: 500 },
      ],
      totalAvailableCents: 1200,
      asOfLocalDate: '2026-09-27',
    });
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
});
