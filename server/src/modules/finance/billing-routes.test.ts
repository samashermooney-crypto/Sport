import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { newId } from '@shared/ids';
import express from 'express';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import type { AuthDependencies } from '../auth/routes.js';

import { billingCheckoutResponseSchema } from './billing-checkout.js';
import {
  billingOverviewSchema,
  billingPortalResponseSchema,
  createFinanceRouter,
} from './routes.js';

const origin = 'http://127.0.0.1:5173';
const now = new Date('2026-09-27T12:00:00Z');
let database: Kysely<DB>;
let adminDatabase: Kysely<DB>;
let orgId: string;
let planId: string;
let token: string;
let financeToken: string;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
const createBillingCustomer = vi
  .fn()
  .mockResolvedValue({ id: 'cus_test_org_billing' });
const createBillingCheckout = vi.fn().mockResolvedValue({
  id: 'cs_test_org_billing',
  url: 'https://checkout.stripe.com/test/org-billing',
});
const createBillingPortal = vi.fn().mockResolvedValue({
  url: 'https://billing.stripe.com/p/session/test',
});

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  adminDatabase = createDatabase(process.env.TEST_DATABASE_URL ?? '');
  const accountId = newId();
  orgId = newId();
  planId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `owner-billing-${randomUUID()}@example.invalid`,
      first_name: 'Owner',
      last_name: 'Billing',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `owner-billing-${randomUUID().slice(0, 12)}`,
      name: 'Owner Billing',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  await adminDatabase
    .insertInto('plans')
    .values({
      id: planId,
      key: `owner-billing-${randomUUID().slice(0, 12)}`,
      name: 'Owner Billing Plan',
      monthly_price_cents: 2500,
      stripe_price_id: `price_${randomUUID().replaceAll('-', '')}`,
      application_fee_bps: 150,
      application_fee_fixed_cents: 0,
    })
    .execute();
  const context = { orgId, actor: { accountId } };
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        status: 'active',
        joined_at: now,
      })
      .execute();
    await trx
      .insertInto('role_assignments')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        role: 'owner',
        scope_type: 'org',
        pending_mfa: false,
      })
      .execute();
  });
  token = randomBytes(32).toString('base64url');
  await database
    .insertInto('sessions')
    .values({
      id: newId(),
      account_id: accountId,
      token_hash: createHash('sha256').update(token).digest(),
      kind: 'cookie',
      client: 'web',
      privileged: false,
      idle_expires_at: new Date(now.getTime() + 60 * 60 * 1000),
      absolute_expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    })
    .execute();
  const financeAccountId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: financeAccountId,
      email: `finance-billing-${randomUUID()}@example.invalid`,
      first_name: 'Finance',
      last_name: 'Billing',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await createWithOrg(database)(
    { orgId, actor: { accountId: financeAccountId } },
    async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: financeAccountId,
          status: 'active',
          joined_at: now,
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: financeAccountId,
          role: 'finance',
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
    },
  );
  financeToken = randomBytes(32).toString('base64url');
  await database
    .insertInto('sessions')
    .values({
      id: newId(),
      account_id: financeAccountId,
      token_hash: createHash('sha256').update(financeToken).digest(),
      kind: 'cookie',
      client: 'web',
      privileged: false,
      idle_expires_at: new Date(now.getTime() + 60 * 60 * 1000),
      absolute_expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    })
    .execute();
  const app = express();
  app.use(
    '/api/v1/finance',
    createFinanceRouter(
      { database, appUrl: origin, clock: () => now } as AuthDependencies,
      () =>
        ({
          createBillingCustomer,
          createBillingCheckout,
          createBillingPortal,
        }) as unknown as PaymentsGateway,
    ),
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/finance`;
});

afterAll(async () => {
  server.close();
  await database.destroy();
  await adminDatabase.destroy();
});

it('starts one owner-only test Billing Checkout and replays the exact key', async () => {
  const root = `${baseUrl}/orgs/${orgId}/billing`;
  const overview = await fetch(root, {
    headers: { Cookie: `__Host-athlentry_session=${token}` },
  });
  expect(overview.status).toBe(200);
  expect(
    billingOverviewSchema.parse((await overview.json()) as unknown).plans,
  ).toContainEqual({
    id: planId,
    name: 'Owner Billing Plan',
    monthlyPriceCents: 2500,
  });
  const headers = {
    Cookie: `__Host-athlentry_session=${token}`,
    Origin: origin,
    'X-Athlentry-Request': '1',
    'Content-Type': 'application/json',
    'Idempotency-Key': randomUUID(),
  };
  const request = () =>
    fetch(`${root}/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ planId }),
    });
  const first = await request();
  expect(first.status).toBe(201);
  const created = billingCheckoutResponseSchema.parse(
    (await first.json()) as unknown,
  );
  const pending = await fetch(root, {
    headers: { Cookie: `__Host-athlentry_session=${token}` },
  });
  expect(
    billingOverviewSchema.parse((await pending.json()) as unknown).checkout,
  ).toMatchObject({
    planId,
    status: 'created',
    url: created.url,
  });
  const second = await request();
  expect(
    billingCheckoutResponseSchema.parse((await second.json()) as unknown),
  ).toEqual(created);
  expect(createBillingCustomer).toHaveBeenCalledTimes(1);
  expect(createBillingCheckout).toHaveBeenCalledTimes(1);
  const otherKey = await fetch(`${root}/checkout`, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ planId }),
  });
  expect(otherKey.status).toBe(409);
  const portal = await fetch(`${root}/portal`, { method: 'POST', headers });
  expect(portal.status).toBe(200);
  expect(
    billingPortalResponseSchema.parse((await portal.json()) as unknown).url,
  ).toContain('billing.stripe.com');
  const wrongOrigin = await fetch(`${root}/checkout`, {
    method: 'POST',
    headers: { ...headers, Origin: 'https://attacker.example' },
    body: JSON.stringify({ planId }),
  });
  expect(wrongOrigin.status).toBe(403);
  const financeOnly = await fetch(root, {
    headers: { Cookie: `__Host-athlentry_session=${financeToken}` },
  });
  expect(financeOnly.status).toBe(403);
});
