import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import type { PayoutMirror } from './payouts.js';

/** Tenant-scoped, atomic Stripe payout mirror. Conflicting Stripe facts are errors. */
export class PostgresPayoutMirror implements PayoutMirror {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    database: Kysely<DB>,
    private readonly actorAccountId: string,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async saveComplete(
    input: Parameters<PayoutMirror['saveComplete']>[0],
  ): Promise<void> {
    const context: OrgContext = {
      orgId: input.orgId,
      actor: { accountId: this.actorAccountId },
    };
    await this.withOrg(context, async (trx) => {
      const account = await trx
        .selectFrom('payment_accounts')
        .select('stripe_account_id')
        .where('org_id', '=', input.orgId)
        .executeTakeFirst();
      if (account?.stripe_account_id !== input.accountId)
        throw new Error('Payout account does not belong to organization');

      await trx
        .insertInto('payouts')
        .values({
          id: newId(),
          org_id: input.orgId,
          stripe_payout_id: input.payout.id,
          amount_cents: input.payout.amountCents,
          arrival_date: new Date(input.payout.arrivalDate * 1000)
            .toISOString()
            .slice(0, 10),
          status: input.payout.status,
          balance_transaction_ids: [],
        })
        .onConflict((conflict) =>
          conflict.column('stripe_payout_id').doNothing(),
        )
        .execute();
      const existingPayout = await trx
        .selectFrom('payouts')
        .select(['id', 'amount_cents'])
        .where('org_id', '=', input.orgId)
        .where('stripe_payout_id', '=', input.payout.id)
        .forUpdate()
        .executeTakeFirst();
      if (
        !existingPayout ||
        existingPayout.amount_cents !== input.payout.amountCents
      )
        throw new Error('Stripe payout ownership or amount conflict');

      for (const transaction of input.transactions) {
        await trx
          .insertInto('balance_transactions')
          .values({
            id: newId(),
            org_id: input.orgId,
            stripe_balance_transaction_id: transaction.id,
            stripe_payout_id: input.payout.id,
            type: transaction.type,
            amount_cents: transaction.amountCents,
            fee_cents: transaction.feeCents,
            net_cents: transaction.netCents,
            source_id: transaction.sourceId,
          })
          .onConflict((conflict) =>
            conflict.column('stripe_balance_transaction_id').doNothing(),
          )
          .execute();
        const stored = await trx
          .selectFrom('balance_transactions')
          .select([
            'stripe_payout_id',
            'type',
            'amount_cents',
            'fee_cents',
            'net_cents',
            'source_id',
          ])
          .where('org_id', '=', input.orgId)
          .where('stripe_balance_transaction_id', '=', transaction.id)
          .forUpdate()
          .executeTakeFirst();
        if (
          !stored ||
          stored.stripe_payout_id !== input.payout.id ||
          stored.type !== transaction.type ||
          stored.amount_cents !== transaction.amountCents ||
          stored.fee_cents !== transaction.feeCents ||
          stored.net_cents !== transaction.netCents ||
          stored.source_id !== transaction.sourceId
        )
          throw new Error(
            'Stripe balance transaction ownership or amount conflict',
          );
      }

      await trx
        .updateTable('payouts')
        .set({
          status: input.payout.status,
          arrival_date: new Date(input.payout.arrivalDate * 1000)
            .toISOString()
            .slice(0, 10),
          balance_transaction_ids: input.transactions.map(
            (transaction) => transaction.id,
          ),
          version: sql`version + 1`,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', existingPayout.id)
        .execute();
    });
  }
}
