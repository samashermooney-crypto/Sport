import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { newId } from '@shared/ids';
import express from 'express';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import type { AuthDependencies } from '../auth/routes.js';

import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresPayerProfileRepository } from './payer-repo.js';
import { createFinanceRouter } from './routes.js';

const origin = 'http://127.0.0.1:5173';
let database: Kysely<DB>;
let context: OrgContext;
let checkoutId: string;
let invoiceId: string;
let token: string;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
const createDestinationPayment = vi.fn().mockResolvedValue({
  id: 'pi_checkout_route',
  clientSecret: 'pi_checkout_route_secret_test',
  status: 'requires_payment_method',
  amountCents: 1000,
});

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  checkoutId = newId();
  const now = new Date();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `payment-route-${randomUUID()}@example.invalid`,
      first_name: 'Pay',
      last_name: 'Route',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `pay-route-${randomUUID().slice(0, 8)}`,
      name: 'Payment Route',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  const invoice = await new PostgresInvoiceRepository(database, context).issue({
    orgId,
    accountId,
    source: 'checkout',
    creationKey: randomUUID(),
    lines: [
      {
        kind: 'registration',
        description: 'Registration',
        amountCents: 1000,
        refundable: true,
      },
    ],
  });
  invoiceId = invoice.id;
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        org_id: orgId,
        account_id: accountId,
        status: 'awaiting_payment',
        expires_at: new Date(now.getTime() + 1_200_000),
        pricing_snapshot: {
          subtotalCents: 1000,
          discountCents: 0,
          aidCents: 0,
          creditAppliedCents: 0,
          serviceFeeCents: 0,
          taxCents: 0,
          invoiceTotalCents: 1000,
          chargeNowCents: 1000,
          paymentTerms: {
            applicationRate: { bps: 150, fixedCents: 0 },
            serviceFee: { enabled: false },
          },
        },
      })
      .execute();
    await trx
      .insertInto('payment_accounts')
      .values({
        id: newId(),
        org_id: orgId,
        stripe_account_id: 'acct_payment_route',
        onboarding_status: 'active',
        charges_enabled: true,
        payouts_enabled: true,
      })
      .execute();
  });
  const profiles = new PostgresPayerProfileRepository(database);
  expect(await profiles.reserve(accountId)).toEqual({ kind: 'reserved' });
  await profiles.save(accountId, 'cus_payment_route');
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
      idle_expires_at: new Date(now.getTime() + 3_600_000),
      absolute_expires_at: new Date(now.getTime() + 86_400_000),
    })
    .execute();
  const app = express();
  app.use(
    '/api/v1/finance',
    createFinanceRouter(
      { database, appUrl: origin, clock: () => now } as AuthDependencies,
      () =>
        ({
          retrieveAccount: vi.fn().mockResolvedValue({
            id: 'acct_payment_route',
            chargesEnabled: true,
          }),
          createDestinationPayment,
        }) as unknown as PaymentsGateway,
    ),
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/finance`;
});

afterAll(async () => {
  server.close();
  await database.destroy();
});

function paymentRequest(
  key: string,
  requestOrigin = origin,
): Promise<Response> {
  return fetch(`${baseUrl}/orgs/${context.orgId}/checkout-payment-intents`, {
    method: 'POST',
    headers: {
      Cookie: `__Host-athlentry_session=${token}`,
      Origin: requestOrigin,
      'X-Athlentry-Request': '1',
      'Idempotency-Key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ checkoutId, invoiceId, saveForAutopay: false }),
  });
}

describe('checkout payment HTTP', () => {
  it('blocks cross-origin calls and records exactly one test-mode intent before replay', async () => {
    const key = randomUUID();
    expect((await paymentRequest(key, 'https://attacker.example')).status).toBe(
      403,
    );
    expect(createDestinationPayment).not.toHaveBeenCalled();
    const first = await paymentRequest(key);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      id: 'pi_checkout_route',
      quote: { amountCents: 1000, applicationFeeCents: 15 },
    });
    const replay = await paymentRequest(key);
    expect(replay.status).toBe(201);
    expect(createDestinationPayment).toHaveBeenCalledTimes(1);
    expect(createDestinationPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedAccountId: 'acct_payment_route',
        customerId: 'cus_payment_route',
        applicationFeeCents: 15,
      }),
    );
    const stored = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('payments')
        .select(['amount_cents', 'application_fee_cents'])
        .where('org_id', '=', context.orgId)
        .where('stripe_payment_intent_id', '=', 'pi_checkout_route')
        .executeTakeFirstOrThrow(),
    );
    expect(stored).toMatchObject({
      amount_cents: 1000,
      application_fee_cents: 15,
    });
  });
});
