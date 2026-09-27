import { z } from 'zod';

import type { StripeEventHandlers } from '../../integrations/stripe/dispatch.js';
import type {
  GatewayBalanceTransaction,
  GatewayPayout,
  PaymentsGateway,
} from '../../integrations/stripe/gateway.js';
import type { StripeWebhookEvent } from '../../integrations/stripe/webhooks.js';

export interface PayoutMirror {
  saveComplete(input: {
    orgId: string;
    accountId: string;
    payout: GatewayPayout;
    transactions: GatewayBalanceTransaction[];
  }): Promise<void>;
}

function assertPayout(payout: GatewayPayout): void {
  if (!payout.id.startsWith('po_')) throw new Error('Invalid Stripe payout ID');
  if (!Number.isSafeInteger(payout.amountCents) || payout.amountCents < 1)
    throw new Error('Invalid Stripe payout amount');
  if (!Number.isSafeInteger(payout.arrivalDate) || payout.arrivalDate < 0)
    throw new Error('Invalid Stripe payout arrival date');
}

/** Fetches every Stripe page before replacing a payout mirror in one transaction. */
export class PayoutSyncService {
  constructor(
    private readonly gateway: Pick<
      PaymentsGateway,
      'retrievePayout' | 'listPayouts' | 'listBalanceTransactions'
    >,
    private readonly mirror: PayoutMirror,
  ) {}

  async syncPayout(
    orgId: string,
    accountId: string,
    payoutId: string,
  ): Promise<void> {
    if (!payoutId.startsWith('po_'))
      throw new Error('Invalid Stripe payout ID');
    const payout = await this.gateway.retrievePayout(accountId, payoutId);
    if (payout.id !== payoutId)
      throw new Error('Stripe returned a different payout');
    await this.save(orgId, accountId, payout);
  }

  async syncAccount(orgId: string, accountId: string): Promise<number> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    let count = 0;
    for (;;) {
      const page = await this.gateway.listPayouts(accountId, cursor);
      for (const payout of page.items) {
        assertPayout(payout);
        if (seen.has(payout.id)) throw new Error('Repeated Stripe payout page');
        seen.add(payout.id);
        await this.save(orgId, accountId, payout);
        count += 1;
      }
      if (!page.hasMore) return count;
      const next = page.items.at(-1)?.id;
      if (!next || next === cursor)
        throw new Error('Stripe payout pagination stalled');
      cursor = next;
    }
  }

  private async save(
    orgId: string,
    accountId: string,
    payout: GatewayPayout,
  ): Promise<void> {
    assertPayout(payout);
    let cursor: string | undefined;
    const seen = new Set<string>();
    const transactions: GatewayBalanceTransaction[] = [];
    for (;;) {
      const page = await this.gateway.listBalanceTransactions(
        accountId,
        payout.id,
        cursor,
      );
      for (const transaction of page.items) {
        if (!transaction.id.startsWith('txn_'))
          throw new Error('Invalid Stripe balance transaction ID');
        if (seen.has(transaction.id))
          throw new Error('Repeated Stripe balance transaction page');
        if (
          ![
            transaction.amountCents,
            transaction.feeCents,
            transaction.netCents,
          ].every(Number.isSafeInteger) ||
          transaction.feeCents < 0 ||
          transaction.netCents !==
            transaction.amountCents - transaction.feeCents
        )
          throw new Error('Invalid Stripe balance transaction cents');
        seen.add(transaction.id);
        transactions.push(transaction);
      }
      if (!page.hasMore) break;
      const next = page.items.at(-1)?.id;
      if (!next || next === cursor)
        throw new Error('Stripe balance transaction pagination stalled');
      cursor = next;
    }
    await this.mirror.saveComplete({ orgId, accountId, payout, transactions });
  }
}

const payoutObject = z.object({
  id: z.string().startsWith('po_'),
  object: z.literal('payout'),
});

export function payoutHandlers(
  service: PayoutSyncService,
  resolveOrg: (stripeAccountId: string) => Promise<string>,
): StripeEventHandlers {
  const handle = async (event: StripeWebhookEvent): Promise<void> => {
    if (!event.account?.startsWith('acct_'))
      throw new Error('Connected payout event has no Stripe account');
    const payout = payoutObject.parse(event.data.object);
    const orgId = await resolveOrg(event.account);
    await service.syncPayout(orgId, event.account, payout.id);
  };
  return {
    'payout.created': handle,
    'payout.paid': handle,
    'payout.failed': handle,
  };
}
