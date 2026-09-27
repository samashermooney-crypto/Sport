import { describe, expect, it, vi } from 'vitest';

import { scanDueInstallments } from './installment-charge-job.js';

const now = '2026-09-27T15:00:00.000Z';

describe('scheduled installment charge scan', () => {
  it('drains due claims with one stable time and stops at the first empty claim', async () => {
    const chargeOne = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'created', paymentIntentId: 'pi_one' })
      .mockResolvedValueOnce({ kind: 'created', paymentIntentId: 'pi_two' })
      .mockResolvedValue({ kind: 'none' });
    await expect(
      scanDueInstallments(['org_a'], now, chargeOne),
    ).resolves.toEqual({
      created: 2,
    });
    expect(chargeOne).toHaveBeenCalledTimes(3);
    expect(chargeOne).toHaveBeenNthCalledWith(2, 'org_a', now);
  });

  it('caps one run per org and scans later orgs after a failed claim', async () => {
    let firstOrgCalls = 0;
    let secondOrgCalls = 0;
    const chargeOne = (orgId: string) => {
      if (orgId === 'org_a') {
        firstOrgCalls += 1;
        return Promise.resolve({
          kind: 'created' as const,
          paymentIntentId: 'pi_test',
        });
      }
      secondOrgCalls += 1;
      return Promise.reject(new Error('Stripe unavailable'));
    };
    await expect(
      scanDueInstallments(['org_a', 'org_b'], now, chargeOne),
    ).rejects.toThrow('Installment charge job failed');
    expect(firstOrgCalls).toBe(100);
    expect(secondOrgCalls).toBe(1);
  });
});
