import { describe, expect, it, vi } from 'vitest';

import { payoutHandlers, PayoutSyncService } from './payouts.js';

const payout = {
  id: 'po_test',
  amountCents: 950,
  status: 'paid',
  arrivalDate: 1_700_000_000,
};
const first = {
  id: 'txn_first',
  amountCents: 1000,
  feeCents: 50,
  netCents: 950,
  sourceId: 'ch_one',
  type: 'charge',
};
const second = {
  id: 'txn_second',
  amountCents: -100,
  feeCents: 0,
  netCents: -100,
  sourceId: 're_one',
  type: 'refund',
};

describe('payout sync', () => {
  it('fetches all balance pages and saves only the complete payout', async () => {
    const saveComplete = vi.fn().mockResolvedValue(undefined);
    const gateway = {
      retrievePayout: vi.fn().mockResolvedValue(payout),
      listPayouts: vi.fn(),
      listBalanceTransactions: vi
        .fn()
        .mockResolvedValueOnce({ items: [first], hasMore: true })
        .mockResolvedValueOnce({ items: [second], hasMore: false }),
    };
    const service = new PayoutSyncService(gateway, { saveComplete });
    await service.syncPayout('org-one', 'acct_one', payout.id);
    expect(gateway.listBalanceTransactions).toHaveBeenNthCalledWith(
      2,
      'acct_one',
      payout.id,
      first.id,
    );
    expect(saveComplete).toHaveBeenCalledWith({
      orgId: 'org-one',
      accountId: 'acct_one',
      payout,
      transactions: [first, second],
    });
  });

  it('rejects repeated transaction pages before storage and requires Connect account', async () => {
    const saveComplete = vi.fn();
    const gateway = {
      retrievePayout: vi.fn().mockResolvedValue(payout),
      listPayouts: vi.fn(),
      listBalanceTransactions: vi
        .fn()
        .mockResolvedValue({ items: [first], hasMore: true }),
    };
    const service = new PayoutSyncService(gateway, { saveComplete });
    await expect(
      service.syncPayout('org-one', 'acct_one', payout.id),
    ).rejects.toThrow('Repeated');
    expect(saveComplete).not.toHaveBeenCalled();
    const handlers = payoutHandlers(service, () => Promise.resolve('org-one'));
    const event = {
      id: 'evt_one',
      object: 'event',
      type: 'payout.paid',
      livemode: false,
      created: 1,
      data: { object: { id: payout.id, object: 'payout' } },
    } as Parameters<NonNullable<(typeof handlers)['payout.paid']>>[0];
    await expect(handlers['payout.paid']?.(event)).rejects.toThrow(
      'no Stripe account',
    );
  });
});
