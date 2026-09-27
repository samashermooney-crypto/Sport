import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresCreditLedger } from './credits.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let ledger: PostgresCreditLedger;
let invoices: PostgresInvoiceRepository;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `credit-${randomUUID()}@example.invalid`,
      first_name: 'Credit',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `credit-${randomUUID().slice(0, 12)}`,
      name: 'Credit Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  ledger = new PostgresCreditLedger(database, context);
  invoices = new PostgresInvoiceRepository(database, context);
});

afterAll(async () => {
  await database.destroy();
});

async function invoice() {
  return invoices.issue({
    orgId: context.orgId,
    accountId: context.actor.accountId,
    source: 'staff',
    creationKey: randomUUID(),
    lines: [
      {
        kind: 'team_fee',
        description: 'Team fee',
        amountCents: 1000,
        refundable: true,
      },
    ],
  });
}

async function state(invoiceId: string) {
  return createWithOrg(database)(context, (trx) =>
    trx
      .selectFrom('invoices')
      .select(['status', 'credit_applied_cents', 'balance_cents'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow(),
  );
}

describe('account credit source ledger', () => {
  it('waits for an unsettled payment before debiting account credit', async () => {
    const bill = await invoice();
    await ledger.issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      amountCents: 100,
      source: 'goodwill',
      operationKey: randomUUID(),
    });
    const paymentId = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('payments')
        .values({
          id: paymentId,
          org_id: context.orgId,
          account_id: context.actor.accountId,
          method: 'card',
          status: 'requires_action',
          amount_cents: 100,
        })
        .execute();
      await trx
        .insertInto('payment_allocations')
        .values({
          id: newId(),
          org_id: context.orgId,
          payment_id: paymentId,
          invoice_id: bill.id,
          amount_cents: 100,
        })
        .execute();
    });
    const request = {
      orgId: context.orgId,
      accountId: context.actor.accountId,
      invoiceId: bill.id,
      amountCents: 100,
      todayLocal: '2026-09-26',
      operationKey: randomUUID(),
    };
    await expect(ledger.apply(request)).rejects.toThrow('unsettled payment');
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('payments')
        .set({ status: 'canceled' })
        .where('org_id', '=', context.orgId)
        .where('id', '=', paymentId)
        .execute(),
    );
    await ledger.apply(request);
    expect((await state(bill.id)).credit_applied_cents).toBe(100);
  });
  it('issues by key and applies FIFO sources to an invoice exactly once', async () => {
    const key = randomUUID();
    const source1 = await ledger.issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      amountCents: 700,
      source: 'goodwill',
      expiresOn: '2026-09-30',
      operationKey: key,
    });
    expect(
      await ledger.issue({
        orgId: context.orgId,
        accountId: context.actor.accountId,
        amountCents: 700,
        source: 'goodwill',
        expiresOn: '2026-09-30',
        operationKey: key,
      }),
    ).toBe(source1);
    await expect(
      ledger.issue({
        orgId: context.orgId,
        accountId: context.actor.accountId,
        amountCents: 701,
        source: 'goodwill',
        expiresOn: '2026-09-30',
        operationKey: key,
      }),
    ).rejects.toThrow('conflicts');
    await ledger.issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      amountCents: 500,
      source: 'refund',
      expiresOn: '2026-09-30',
      operationKey: randomUUID(),
    });
    const bill = await invoice();
    const application = {
      orgId: context.orgId,
      accountId: context.actor.accountId,
      invoiceId: bill.id,
      amountCents: 800,
      todayLocal: '2026-09-26',
      operationKey: randomUUID(),
    };
    await ledger.apply(application);
    await ledger.apply(application);
    await expect(
      ledger.apply({ ...application, amountCents: 799 }),
    ).rejects.toThrow('conflicts');
    expect(await state(bill.id)).toEqual({
      status: 'partially_paid',
      credit_applied_cents: 800,
      balance_cents: 200,
    });
    const allocations = await createWithOrg(database)(context, (trx) =>
      sql<{ total: number }>`
      SELECT coalesce(-sum(amount_cents), 0)::bigint AS total FROM credits
      WHERE org_id = ${context.orgId}::uuid AND invoice_id = ${bill.id}::uuid
        AND kind = 'applied'
    `.execute(trx),
    );
    expect(allocations.rows[0]?.total).toBe(800);
  });

  it('serializes concurrent applications and expires only unused source cents', async () => {
    const first = await invoice();
    const second = await invoice();
    const applications = await Promise.allSettled(
      [first, second].map((bill) =>
        ledger.apply({
          orgId: context.orgId,
          accountId: context.actor.accountId,
          invoiceId: bill.id,
          amountCents: 300,
          todayLocal: '2026-09-26',
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(
      applications.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      applications.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await ledger.balance({
        orgId: context.orgId,
        accountId: context.actor.accountId,
        todayLocal: '2026-09-26',
      }),
    ).toBe(100);
    const issue = await createWithOrg(database)(context, (trx) =>
      sql<{ id: string }>`
      SELECT id FROM credits WHERE org_id = ${context.orgId}::uuid
        AND kind = 'issued' AND amount_cents = 500
    `.execute(trx),
    );
    const sourceId = issue.rows[0]?.id;
    if (!sourceId) throw new Error('Second credit source missing');
    expect(
      await ledger.expire({
        orgId: context.orgId,
        sourceCreditId: sourceId,
        todayLocal: '2026-10-01',
      }),
    ).toBe(100);
    expect(
      await ledger.expire({
        orgId: context.orgId,
        sourceCreditId: sourceId,
        todayLocal: '2026-10-01',
      }),
    ).toBe(0);
    expect(
      await ledger.balance({
        orgId: context.orgId,
        accountId: context.actor.accountId,
        todayLocal: '2026-10-01',
      }),
    ).toBe(0);
  });

  it('applies household credit only to an invoice for that household', async () => {
    const householdId = newId();
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('households')
        .values({
          id: householdId,
          org_id: context.orgId,
          name: 'Credit Household',
        })
        .execute(),
    );
    const sourceId = await ledger.issue({
      orgId: context.orgId,
      householdId,
      amountCents: 250,
      source: 'goodwill',
      expiresOn: '2026-09-30',
      operationKey: randomUUID(),
    });
    const bill = await invoices.issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      householdId,
      source: 'staff',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'team_fee',
          description: 'Household fee',
          amountCents: 300,
          refundable: true,
        },
      ],
    });
    await ledger.apply({
      orgId: context.orgId,
      householdId,
      invoiceId: bill.id,
      amountCents: 200,
      todayLocal: '2026-09-26',
      operationKey: randomUUID(),
    });
    expect(await state(bill.id)).toEqual({
      status: 'partially_paid',
      credit_applied_cents: 200,
      balance_cents: 100,
    });
    expect(
      await ledger.balance({
        orgId: context.orgId,
        householdId,
        todayLocal: '2026-09-26',
      }),
    ).toBe(50);
    const reversal = {
      orgId: context.orgId,
      sourceCreditId: sourceId,
      reason: 'Award withdrawn',
      operationKey: randomUUID(),
    };
    expect(await ledger.reverseUnused(reversal)).toBe(50);
    expect(await ledger.reverseUnused(reversal)).toBe(50);
    expect(
      await ledger.balance({
        orgId: context.orgId,
        householdId,
        todayLocal: '2026-09-26',
      }),
    ).toBe(0);
    expect(
      await ledger.expire({
        orgId: context.orgId,
        sourceCreditId: sourceId,
        todayLocal: '2026-10-01',
      }),
    ).toBe(0);
    await expect(
      createWithOrg(database)(context, (trx) =>
        sql`
      INSERT INTO credits
        (id, org_id, household_id, amount_cents, kind, source, created_by, source_credit_id)
      VALUES
        (${newId()}::uuid, ${context.orgId}::uuid, ${householdId}::uuid,
         -1, 'expired', 'expiry', ${context.actor.accountId}::uuid, ${sourceId}::uuid)
    `.execute(trx),
      ),
    ).rejects.toThrow('overdrawn');
    await expect(
      createWithOrg(database)(context, (trx) =>
        sql`
      UPDATE credits SET note = 'edited'
      WHERE org_id = ${context.orgId}::uuid AND id = ${sourceId}::uuid
    `.execute(trx),
      ),
    ).rejects.toThrow('append-only');
  });
});
