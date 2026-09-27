import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresInvoiceRepository } from './invoice-repo.js';
import { invoiceTotals, type IssueInvoiceInput } from './invoices.js';

let database: Kysely<DB>;
let context: OrgContext;
let repository: PostgresInvoiceRepository;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `invoice-${randomUUID()}@example.invalid`,
      first_name: 'Invoice',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `invoice-${randomUUID().slice(0, 12)}`,
      name: 'Invoice Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  repository = new PostgresInvoiceRepository(database, context);
});

afterAll(async () => {
  await database.destroy();
});

function input(key = randomUUID()): IssueInvoiceInput {
  return {
    orgId: context.orgId,
    accountId: context.actor.accountId,
    source: 'order',
    creationKey: key,
    lines: [
      {
        kind: 'product',
        description: 'Uniform',
        amountCents: 1000,
        refundable: true,
      },
      {
        kind: 'discount',
        description: 'Promo',
        amountCents: -100,
        refundable: false,
      },
      {
        kind: 'tax',
        description: 'Sales tax',
        amountCents: 45,
        refundable: true,
        taxRateBps: 500,
      },
    ],
  };
}

describe('invoice issuance', () => {
  it('assigns one number and reconciles header and lines at commit', async () => {
    const request = input();
    expect(invoiceTotals(request)).toEqual({
      subtotalCents: 1000,
      discountCents: 100,
      serviceFeeCents: 0,
      taxCents: 45,
      totalCents: 945,
    });
    const [first, replay] = await Promise.all([
      repository.issue(request),
      repository.issue(request),
    ]);
    expect(first).toEqual(replay);
    expect(first.number).toBe(1);
    const header = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('invoices')
        .select(['number', 'total_cents', 'balance_cents', 'tax_cents'])
        .where('id', '=', first.id)
        .executeTakeFirstOrThrow(),
    );
    expect(header).toEqual({
      number: 1,
      total_cents: 945,
      balance_cents: 945,
      tax_cents: 45,
    });
    const second = await repository.issue(input());
    expect(second.number).toBe(2);
  });

  it('rejects a changed request under one key and tax outside an order', async () => {
    const request = input();
    await repository.issue(request);
    await expect(
      repository.issue({
        ...request,
        lines: [
          {
            kind: 'product',
            description: 'Uniform',
            amountCents: 900,
            refundable: true,
          },
        ],
      }),
    ).rejects.toThrow('different request');
    expect(() => invoiceTotals({ ...input(), source: 'staff' })).toThrow(
      'only to product orders',
    );
  });
});
