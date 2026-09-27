import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import type { OrgContext } from '../../db/withOrg.js';

import {
  BillingCustomerService,
  PostgresBillingCustomerClaims,
} from './billing-customer.js';

let database: Kysely<DB>;
let accountId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  accountId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `billing-claim-${randomUUID()}@example.invalid`,
      first_name: 'Billing',
      last_name: 'Claim',
      date_of_birth: '1990-01-01',
    })
    .execute();
});

afterAll(async () => {
  await database.destroy();
});

async function org(): Promise<OrgContext> {
  const orgId = newId();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `billing-claim-${randomUUID().slice(0, 12)}`,
      name: 'Billing Claim',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  return { orgId, actor: { accountId } };
}

it('creates one Customer from a durable claim and replays the stored ID', async () => {
  const context = await org();
  const claims = new PostgresBillingCustomerClaims(database, context);
  const createBillingCustomer = vi
    .fn()
    .mockResolvedValue({ id: 'cus_claim_one' });
  const service = new BillingCustomerService(claims, { createBillingCustomer });
  const input = {
    orgId: context.orgId,
    name: 'Billing Claim',
    email: 'billing@example.invalid',
  };
  expect(await service.getOrCreate(input)).toBe('cus_claim_one');
  expect(await service.getOrCreate(input)).toBe('cus_claim_one');
  expect(createBillingCustomer).toHaveBeenCalledTimes(1);
  expect(createBillingCustomer).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: `billing-customer:${context.orgId}`,
    }),
  );
});

it('fences retries when Customer creation has an ambiguous external outcome', async () => {
  const context = await org();
  const createBillingCustomer = vi
    .fn()
    .mockRejectedValue(new Error('Stripe timeout'));
  const service = new BillingCustomerService(
    new PostgresBillingCustomerClaims(database, context),
    { createBillingCustomer },
  );
  const input = {
    orgId: context.orgId,
    name: 'Billing Claim',
    email: 'billing@example.invalid',
  };
  await expect(service.getOrCreate(input)).rejects.toThrow('Stripe timeout');
  await expect(service.getOrCreate(input)).rejects.toThrow('reconciliation');
  expect(createBillingCustomer).toHaveBeenCalledTimes(1);
});
