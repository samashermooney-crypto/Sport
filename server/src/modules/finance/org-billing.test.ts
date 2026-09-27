import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import {
  BillingCheckoutService,
  PostgresBillingCheckoutClaims,
} from './billing-checkout.js';
import { PostgresBillingInvoices } from './billing-invoices.js';
import { PostgresOrgBilling } from './org-billing.js';

let database: Kysely<DB>;
let adminDatabase: Kysely<DB>;
let context: OrgContext;
let planId: string;
let priceId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  adminDatabase = createDatabase(process.env.TEST_DATABASE_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  planId = newId();
  priceId = `price_${randomUUID().replaceAll('-', '')}`;
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `billing-${randomUUID()}@example.invalid`,
      first_name: 'Billing',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `billing-${randomUUID().slice(0, 12)}`,
      name: 'Billing Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  await adminDatabase
    .insertInto('plans')
    .values({
      id: planId,
      key: `billing-${randomUUID().slice(0, 12)}`,
      name: 'Billing Plan',
      monthly_price_cents: 2500,
      stripe_price_id: priceId,
      application_fee_bps: 275,
      application_fee_fixed_cents: 25,
    })
    .execute();
  context = { orgId, actor: { accountId } };
  const visiblePlan = await database
    .selectFrom('plans')
    .select('id')
    .where('stripe_price_id', '=', priceId)
    .executeTakeFirst();
  expect(visiblePlan?.id).toBe(planId);
});

afterAll(async () => {
  await database.destroy();
  await adminDatabase.destroy();
});

it('syncs only a reserved test Customer and applies plan fees once to new charges', async () => {
  const repo = new PostgresOrgBilling(database, context);
  await repo.reserveCustomer('cus_billing_test');
  await repo.reserveCustomer('cus_billing_test');
  await expect(repo.reserveCustomer('cus_other')).rejects.toThrow(
    'another Stripe Customer',
  );
  const checkout = new BillingCheckoutService(
    new PostgresBillingCheckoutClaims(database, context),
    {
      createBillingCheckout: vi.fn().mockResolvedValue({
        id: 'cs_test_billing_mirror',
        url: 'https://checkout.stripe.com/test/billing-mirror',
      }),
    },
  );
  await checkout.start({
    orgId: context.orgId,
    planId,
    requestKey: randomUUID(),
    successUrl: 'https://app.example.test/return',
    cancelUrl: 'https://app.example.test/cancel',
  });
  const latest = {
    id: 'sub_billing_test',
    orgId: context.orgId,
    customerId: 'cus_billing_test',
    priceIds: [priceId],
    status: 'active',
    currentPeriodEnd: 1_900_000_000,
  };
  await expect(
    repo.syncLatest({ ...latest, orgId: randomUUID() }),
  ).rejects.toThrow('unverified');
  expect(await repo.syncLatest(latest)).toBe('applied');
  expect(await repo.syncLatest(latest)).toBe('unchanged');
  const claim = await createWithOrg(database)(context, (trx) =>
    sql<{ status: string }>`
      SELECT status FROM billing_checkout_claims
      WHERE org_id = ${context.orgId}::uuid
    `.execute(trx),
  );
  expect(claim.rows[0]?.status).toBe('fulfilled');
  const invoices = new PostgresBillingInvoices(database, context);
  const bill = {
    id: 'in_test_billing_mirror',
    customerId: 'cus_billing_test',
    subscriptionId: latest.id,
    status: 'open',
    currency: 'usd',
    totalCents: 2500,
    amountPaidCents: 0,
    amountDueCents: 2500,
    created: 1_800_000_000,
  };
  expect(await invoices.applyLatest(bill)).toBe('applied');
  expect(await invoices.applyLatest(bill)).toBe('unchanged');
  expect(
    await invoices.applyLatest({
      ...bill,
      status: 'paid',
      amountPaidCents: 2500,
      amountDueCents: 0,
    }),
  ).toBe('applied');
  await expect(invoices.applyLatest(bill)).rejects.toThrow('regressed');
  await expect(
    invoices.applyLatest({ ...bill, customerId: 'cus_other' }),
  ).rejects.toThrow('not owned');
  const org = await database
    .selectFrom('organizations')
    .select(['plan_id', 'application_fee_bps', 'application_fee_fixed_cents'])
    .where('id', '=', context.orgId)
    .executeTakeFirstOrThrow();
  expect(org).toMatchObject({
    plan_id: planId,
    application_fee_bps: 275,
    application_fee_fixed_cents: 25,
  });
  expect(await repo.syncLatest({ ...latest, status: 'past_due' })).toBe(
    'applied',
  );
  const saved = await createWithOrg(database)(context, (trx) =>
    sql<{ status: string; version: number }>`
      SELECT status, version FROM org_subscriptions
      WHERE org_id = ${context.orgId}::uuid
    `.execute(trx),
  );
  expect(saved.rows[0]).toMatchObject({ status: 'past_due', version: 3 });
});
