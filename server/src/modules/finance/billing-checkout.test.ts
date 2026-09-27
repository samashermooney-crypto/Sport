import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import type { OrgContext } from '../../db/withOrg.js';

import {
  BillingCheckoutService,
  PostgresBillingCheckoutClaims,
} from './billing-checkout.js';
import { PostgresOrgBilling } from './org-billing.js';

let database: Kysely<DB>;
let adminDatabase: Kysely<DB>;
let accountId: string;
let planId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  adminDatabase = createDatabase(process.env.TEST_DATABASE_URL ?? '');
  accountId = newId();
  planId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `billing-checkout-${randomUUID()}@example.invalid`,
      first_name: 'Billing',
      last_name: 'Checkout',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await adminDatabase
    .insertInto('plans')
    .values({
      id: planId,
      key: `billing-checkout-${randomUUID().slice(0, 12)}`,
      name: 'Billing Checkout Plan',
      monthly_price_cents: 2500,
      stripe_price_id: `price_${randomUUID().replaceAll('-', '')}`,
      application_fee_bps: 150,
      application_fee_fixed_cents: 0,
    })
    .execute();
});

afterAll(async () => {
  await database.destroy();
  await adminDatabase.destroy();
});

async function org(): Promise<OrgContext> {
  const orgId = newId();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `billing-checkout-${randomUUID().slice(0, 12)}`,
      name: 'Billing Checkout',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  const context = { orgId, actor: { accountId } };
  await new PostgresOrgBilling(database, context).reserveCustomer(
    `cus_${orgId.replaceAll('-', '')}`,
  );
  return context;
}

function input(context: OrgContext, requestKey: string) {
  return {
    orgId: context.orgId,
    planId,
    requestKey,
    successUrl: `https://app.example.test/console/orgs/${context.orgId}/money/billing`,
    cancelUrl: `https://app.example.test/console/orgs/${context.orgId}/money/billing`,
  };
}

it('replays one session and blocks another key while Checkout is active', async () => {
  const context = await org();
  const createBillingCheckout = vi.fn().mockResolvedValue({
    id: 'cs_test_billing_one',
    url: 'https://checkout.stripe.com/test/session-one',
  });
  const service = new BillingCheckoutService(
    new PostgresBillingCheckoutClaims(database, context),
    { createBillingCheckout },
  );
  const key = randomUUID();
  const first = await service.start(input(context, key));
  expect(await service.start(input(context, key))).toEqual(first);
  expect(createBillingCheckout).toHaveBeenCalledTimes(1);
  await expect(service.start(input(context, randomUUID()))).rejects.toThrow(
    'active',
  );
});

it('fences an ambiguous Stripe Checkout call before any repeat call', async () => {
  const context = await org();
  const createBillingCheckout = vi
    .fn()
    .mockRejectedValue(new Error('Stripe timeout'));
  const service = new BillingCheckoutService(
    new PostgresBillingCheckoutClaims(database, context),
    { createBillingCheckout },
  );
  const request = input(context, randomUUID());
  await expect(service.start(request)).rejects.toThrow('Stripe timeout');
  await expect(service.start(request)).rejects.toThrow('reconciliation');
  expect(createBillingCheckout).toHaveBeenCalledTimes(1);
});

it('serializes simultaneous different keys before Stripe', async () => {
  const context = await org();
  const createBillingCheckout = vi.fn().mockResolvedValue({
    id: 'cs_test_billing_race',
    url: 'https://checkout.stripe.com/test/race',
  });
  const service = new BillingCheckoutService(
    new PostgresBillingCheckoutClaims(database, context),
    { createBillingCheckout },
  );
  const outcomes = await Promise.allSettled([
    service.start(input(context, randomUUID())),
    service.start(input(context, randomUUID())),
  ]);
  expect(
    outcomes.filter((outcome) => outcome.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(
    outcomes.filter((outcome) => outcome.status === 'rejected'),
  ).toHaveLength(1);
  expect(createBillingCheckout).toHaveBeenCalledTimes(1);
});
