import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresProductTaxRates } from './tax-rates.js';

let database: Kysely<DB>;
let context: OrgContext;
beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `tax-${randomUUID()}@example.invalid`,
      first_name: 'Tax',
      last_name: 'Reviewer',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `tax-${randomUUID().slice(0, 12)}`,
      name: 'Tax Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
});
afterAll(async () => {
  await database.destroy();
});

describe('product tax rate configuration', () => {
  it('replays creation, versions edits, and leaves issued invoice tax frozen', async () => {
    const rates = new PostgresProductTaxRates(database, context);
    const key = randomUUID();
    const input = { name: 'Product sales tax', rateBps: 500, active: true };
    const created = await rates.create(input, key);
    expect(await rates.create(input, key)).toEqual(created);
    await expect(rates.create({ ...input, rateBps: 600 }, key)).rejects.toThrow(
      'key was reused',
    );
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'order',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'product',
          description: 'Jersey',
          amountCents: 1000,
          refundable: true,
        },
        {
          kind: 'tax',
          description: 'Product tax',
          amountCents: 50,
          taxRateBps: 500,
          refundable: true,
        },
      ],
    });
    const replaced = await rates.replace(created.id, {
      ...input,
      rateBps: 600,
      expectedVersion: created.version,
    });
    expect(replaced).toMatchObject({ rateBps: 600, version: 2 });
    expect(await rates.resolveActive(created.id)).toEqual(replaced);
    await expect(
      rates.replace(created.id, { ...input, expectedVersion: created.version }),
    ).rejects.toThrow('version changed');
    const taxLine = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('invoice_lines')
        .select(['tax_rate_bps', 'amount_cents'])
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', invoice.id)
        .where('kind', '=', 'tax')
        .executeTakeFirstOrThrow(),
    );
    expect(taxLine).toEqual({ tax_rate_bps: 500, amount_cents: 50 });
    expect(await rates.list()).toContainEqual(replaced);
    await rates.replace(created.id, {
      ...input,
      rateBps: 600,
      active: false,
      expectedVersion: replaced.version,
    });
    await expect(rates.resolveActive(created.id)).rejects.toThrow(
      'unavailable',
    );
  });
});
