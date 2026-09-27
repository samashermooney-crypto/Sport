import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresPayoutMirror } from './payout-repo.js';
import {
  PostgresPayoutReconciliation,
  payoutReconciliationCsv,
} from './reconciliation.js';

let database: Kysely<DB>;
let context: OrgContext;
let other: OrgContext;
let accountId: string;

async function makeContext(): Promise<OrgContext> {
  const actorId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: actorId,
      email: `payout-${randomUUID()}@example.invalid`,
      first_name: 'Payout',
      last_name: 'Actor',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `payout-${randomUUID().slice(0, 12)}`,
      name: 'Payout Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  return { orgId, actor: { accountId: actorId } };
}

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  context = await makeContext();
  other = await makeContext();
  accountId = `acct_${randomUUID()}`;
  await createWithOrg(database)(context, (trx) =>
    trx
      .insertInto('payment_accounts')
      .values({
        id: newId(),
        org_id: context.orgId,
        stripe_account_id: accountId,
        requirements: {},
        statement_descriptor: null,
      })
      .execute(),
  );
});

afterAll(async () => {
  await database.destroy();
});

describe('Postgres payout mirror', () => {
  it('replays, updates status, and rejects mismatched Stripe amounts atomically', async () => {
    const repo = new PostgresPayoutMirror(database, context.actor.accountId);
    const payout = {
      id: `po_${randomUUID()}`,
      amountCents: 950,
      status: 'pending',
      arrivalDate: 1_700_000_000,
    };
    const transaction = {
      id: `txn_${randomUUID()}`,
      amountCents: 1000,
      feeCents: 50,
      netCents: 950,
      sourceId: 'ch_one',
      type: 'charge',
    };
    const input = {
      orgId: context.orgId,
      accountId,
      payout,
      transactions: [transaction],
    };
    await repo.saveComplete(input);
    await repo.saveComplete({
      ...input,
      payout: { ...payout, status: 'paid' },
    });
    await expect(
      repo.saveComplete({
        ...input,
        transactions: [{ ...transaction, feeCents: 51, netCents: 949 }],
      }),
    ).rejects.toThrow('conflict');
    const stored = await createWithOrg(database)(context, async (trx) => ({
      payout: await trx
        .selectFrom('payouts')
        .select(['status', 'balance_transaction_ids'])
        .where('org_id', '=', context.orgId)
        .where('stripe_payout_id', '=', payout.id)
        .executeTakeFirstOrThrow(),
      transaction: await trx
        .selectFrom('balance_transactions')
        .select(['fee_cents'])
        .where('org_id', '=', context.orgId)
        .where('stripe_balance_transaction_id', '=', transaction.id)
        .executeTakeFirstOrThrow(),
    }));
    expect(stored.payout).toMatchObject({
      status: 'paid',
      balance_transaction_ids: [transaction.id],
    });
    expect(stored.transaction.fee_cents).toBe(50);
    const report = await new PostgresPayoutReconciliation(
      database,
      context,
    ).read(payout.id);
    expect(report).toMatchObject({
      amountCents: 950,
      transactionNetCents: 950,
      differenceCents: 0,
      complete: true,
      rows: [{ transactionId: transaction.id, paymentId: null }],
    });
    expect(payoutReconciliationCsv(report)).toContain(transaction.id);
    const reportRow = report.rows[0];
    if (!reportRow) throw new Error('Missing payout transaction');
    expect(
      payoutReconciliationCsv({
        ...report,
        rows: [{ ...reportRow, sourceId: '=HYPERLINK("bad")' }],
      }),
    ).toContain("'=HYPERLINK");
    await expect(
      new PostgresPayoutMirror(database, other.actor.accountId).saveComplete({
        ...input,
        orgId: other.orgId,
      }),
    ).rejects.toThrow('does not belong');
  });
});
