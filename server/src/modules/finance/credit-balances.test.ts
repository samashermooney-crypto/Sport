import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresPayerCreditBalances } from './credit-balances.js';
import { PostgresCreditLedger } from './credits.js';

let database: Kysely<DB>;
let context: OrgContext;
let householdId: string;
let otherHouseholdId: string;
let personId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  householdId = newId();
  otherHouseholdId = newId();
  personId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `credit-balance-${randomUUID()}@example.invalid`,
      first_name: 'Credit',
      last_name: 'Payer',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `credit-balance-${randomUUID().slice(0, 12)}`,
      name: 'Credit Balance Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('people')
      .values({
        id: personId,
        org_id: orgId,
        first_name: 'Credit',
        last_name: 'Payer',
        date_of_birth: '1990-01-01',
      })
      .execute();
    await trx
      .insertInto('person_account_links')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        person_id: personId,
        relationship: 'self',
      })
      .execute();
    await trx
      .insertInto('households')
      .values([
        { id: householdId, org_id: orgId, name: 'Authorized family' },
        { id: otherHouseholdId, org_id: orgId, name: 'Private family' },
      ])
      .execute();
    await trx
      .insertInto('household_members')
      .values({
        id: newId(),
        org_id: orgId,
        household_id: householdId,
        person_id: personId,
        role: 'guardian',
        financially_responsible: true,
      })
      .execute();
  });
});
afterAll(async () => {
  await database.destroy();
});

describe('payer credit balance', () => {
  it('shows unexpired personal and linked household sources after debits only', async () => {
    const ledger = new PostgresCreditLedger(database, context);
    const accountSource = await ledger.issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      amountCents: 1000,
      source: 'goodwill',
      operationKey: randomUUID(),
    });
    await ledger.issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      amountCents: 200,
      expiresOn: '2026-09-26',
      source: 'goodwill',
      operationKey: randomUUID(),
    });
    await ledger.issue({
      orgId: context.orgId,
      householdId,
      amountCents: 500,
      source: 'goodwill',
      operationKey: randomUUID(),
    });
    await ledger.issue({
      orgId: context.orgId,
      householdId: otherHouseholdId,
      amountCents: 900,
      source: 'goodwill',
      operationKey: randomUUID(),
    });
    await createWithOrg(database)(context, async (trx) => {
      await sql`
        INSERT INTO credits (id, org_id, account_id, amount_cents,
          kind, source, created_by, source_credit_id)
        VALUES (${newId()}::uuid, ${context.orgId}::uuid,
          ${context.actor.accountId}::uuid, -300, 'applied', 'invoice',
          ${context.actor.accountId}::uuid, ${accountSource}::uuid)
      `.execute(trx);
    });
    const read = () =>
      new PostgresPayerCreditBalances(
        database,
        context,
        () => new Date('2026-09-27T12:00:00Z'),
      ).read();
    const balance = await read();
    expect(balance).toMatchObject({
      accountBalanceCents: 700,
      totalAvailableCents: 1200,
      householdBalances: [{ householdId, balanceCents: 500 }],
      asOfLocalDate: '2026-09-27',
    });
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('person_account_links')
        .set({ revoked_at: new Date() })
        .where('org_id', '=', context.orgId)
        .where('person_id', '=', personId)
        .execute(),
    );
    expect(await read()).toMatchObject({
      accountBalanceCents: 700,
      householdBalances: [],
      totalAvailableCents: 700,
    });
  });
});
