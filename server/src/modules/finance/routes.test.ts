import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Temporal } from '@js-temporal/polyfill';
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
import { PostgresPaymentEventRepository } from './payment-event-repo.js';
import { PostgresPaymentRecordStore } from './payment-repo.js';
import { createFinanceRouter } from './routes.js';

const origin = 'http://127.0.0.1:5173';
const now = new Date('2026-09-27T12:00:00Z');
let database: Kysely<DB>;
let context: OrgContext;
let paymentId: string;
let token: string;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
const createRefund = vi
  .fn()
  .mockResolvedValue({ id: 're_route', status: 'pending', amountCents: 500 });

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  const checkoutId = newId();
  const paymentIntentId = `pi_${randomUUID()}`;
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `refund-route-${randomUUID()}@example.invalid`,
      first_name: 'Refund',
      last_name: 'Route',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `refund-route-${randomUUID().slice(0, 12)}`,
      name: 'Refund Route',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
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
        role: 'finance',
        scope_type: 'org',
        pending_mfa: false,
      })
      .execute();
  });
  const invoice = await new PostgresInvoiceRepository(database, context).issue({
    orgId,
    accountId,
    source: 'checkout',
    creationKey: randomUUID(),
    refundTerms: {
      policy: {
        rules: [],
        afterLastBps: 5000,
        serviceFeeRefund: 'proportional',
      },
      approvalThresholdCents: 500,
      refundApplicationFee: true,
    },
    lines: [
      {
        kind: 'registration',
        description: 'Registration',
        amountCents: 1000,
        refundable: true,
      },
    ],
  });
  await createWithOrg(database)(context, (trx) =>
    trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        org_id: orgId,
        account_id: accountId,
        status: 'awaiting_payment',
        expires_at: new Date('2027-01-01T00:00:00Z'),
        pricing_snapshot: { totalCents: 1000 },
      })
      .execute(),
  );
  await new PostgresPaymentRecordStore(database, context).recordPending({
    orgId,
    checkoutId,
    invoiceId: invoice.id,
    accountId,
    paymentIntentId,
    amountCents: 1000,
    applicationFeeCents: 10,
    idempotencyKey: randomUUID(),
  });
  await new PostgresPaymentEventRepository(database, accountId, () =>
    Temporal.Instant.from(now.toISOString()),
  ).applyLatest({
    orgId,
    paymentIntentId,
    latest: {
      id: paymentIntentId,
      clientSecret: null,
      status: 'succeeded',
      amountCents: 1000,
      latestChargeId: `ch_${randomUUID()}`,
      method: 'card',
    },
  });
  paymentId = (
    await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('payments')
        .select('id')
        .where('org_id', '=', orgId)
        .where('stripe_payment_intent_id', '=', paymentIntentId)
        .executeTakeFirstOrThrow(),
    )
  ).id;
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
  const app = express();
  app.use(
    '/api/v1/finance',
    createFinanceRouter(
      {
        database,
        appUrl: origin,
        clock: () => now,
      } as AuthDependencies,
      () => ({ createRefund }) as unknown as PaymentsGateway,
    ),
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/finance`;
});

afterAll(async () => {
  server.close();
  await database.destroy();
});

function request(
  idempotencyKey: string,
  requestOrigin = origin,
): Promise<Response> {
  return fetch(`${baseUrl}/orgs/${context.orgId}/refunds`, {
    method: 'POST',
    headers: {
      Cookie: `__Host-athlentry_session=${token}`,
      Origin: requestOrigin,
      'X-Athlentry-Request': '1',
      'Idempotency-Key': idempotencyKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      destination: 'original_method',
      paymentId,
      cancellationDate: '2026-09-27',
    }),
  });
}

describe('staff refund HTTP', () => {
  it('rejects cross-origin writes, records an approved-threshold refund and replays it', async () => {
    const key = randomUUID();
    expect((await request(key, 'https://attacker.example')).status).toBe(403);
    expect(createRefund).not.toHaveBeenCalled();
    const first = await request(key);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      destination: 'original_method',
      refundId: 're_route',
      amountCents: 500,
    });
    const replay = await request(key);
    expect(replay.status).toBe(201);
    expect(createRefund).toHaveBeenCalledTimes(1);
  });
});
