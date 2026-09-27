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
import {
  createFinanceRouter,
  payoutJournalResponseSchema,
  refundResponseSchema,
} from './routes.js';

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
const createCustomer = vi.fn().mockResolvedValue({ id: 'cus_route' });
const createSetupIntent = vi.fn().mockResolvedValue({
  id: 'seti_route',
  clientSecret: 'seti_route_secret_test',
});
const listPaymentMethods = vi.fn().mockResolvedValue([
  {
    id: 'pm_route',
    type: 'card',
    brand: 'visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2030,
    bankName: null,
  },
]);
const setDefaultPaymentMethod = vi.fn().mockResolvedValue(undefined);
const detachPaymentMethod = vi.fn().mockResolvedValue(undefined);

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
      () =>
        ({
          createRefund,
          createCustomer,
          createSetupIntent,
          listPaymentMethods,
          setDefaultPaymentMethod,
          detachPaymentMethod,
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

  it('requires a different stepped-up finance account for an above-threshold refund', async () => {
    createRefund.mockResolvedValue({
      id: 're_route_second',
      status: 'pending',
      amountCents: 500,
    });
    const requesterId = context.actor.accountId;
    const approverId = newId();
    const approverToken = randomBytes(32).toString('base64url');
    await database
      .insertInto('accounts')
      .values({
        id: approverId,
        email: `refund-approver-${randomUUID()}@example.invalid`,
        first_name: 'Second',
        last_name: 'Approver',
        date_of_birth: '1990-01-01',
      })
      .execute();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: approverId,
          status: 'active',
          joined_at: now,
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: approverId,
          role: 'finance',
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
    });
    const approverSessionId = newId();
    await database
      .insertInto('sessions')
      .values({
        id: approverSessionId,
        account_id: approverId,
        token_hash: createHash('sha256').update(approverToken).digest(),
        kind: 'cookie',
        client: 'web',
        privileged: false,
        idle_expires_at: new Date(now.getTime() + 60 * 60 * 1000),
        absolute_expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      })
      .execute();
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: requesterId,
      source: 'checkout',
      creationKey: randomUUID(),
      refundTerms: {
        policy: {
          rules: [],
          afterLastBps: 5000,
          serviceFeeRefund: 'proportional',
        },
        approvalThresholdCents: 400,
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
    const checkoutId = newId();
    const paymentIntentId = `pi_${randomUUID()}`;
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('checkouts')
        .values({
          id: checkoutId,
          org_id: context.orgId,
          account_id: requesterId,
          status: 'awaiting_payment',
          expires_at: new Date('2027-01-01T00:00:00Z'),
          pricing_snapshot: { totalCents: 1000 },
        })
        .execute(),
    );
    await new PostgresPaymentRecordStore(database, context).recordPending({
      orgId: context.orgId,
      checkoutId,
      invoiceId: invoice.id,
      accountId: requesterId,
      paymentIntentId,
      amountCents: 1000,
      applicationFeeCents: 10,
      idempotencyKey: randomUUID(),
    });
    await new PostgresPaymentEventRepository(database, requesterId, () =>
      Temporal.Instant.from(now.toISOString()),
    ).applyLatest({
      orgId: context.orgId,
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
    const secondPaymentId = (
      await createWithOrg(database)(context, (trx) =>
        trx
          .selectFrom('payments')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('stripe_payment_intent_id', '=', paymentIntentId)
          .executeTakeFirstOrThrow(),
      )
    ).id;
    const key = randomUUID();
    const body = JSON.stringify({
      destination: 'original_method',
      paymentId: secondPaymentId,
      cancellationDate: '2026-09-27',
    });
    const post = (path: string, sessionToken: string, withBody = true) =>
      fetch(`${baseUrl}/orgs/${context.orgId}/${path}`, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${sessionToken}`,
          Origin: origin,
          'X-Athlentry-Request': '1',
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
        ...(withBody ? { body } : {}),
      });
    expect((await post('refunds', token)).status).toBe(409);
    const requested = await post('refund-approvals', token);
    expect(requested.status).toBe(201);
    const approval = (await requested.json()) as {
      id: string;
      status: string;
      amountCents: number;
    };
    expect(approval).toMatchObject({ status: 'pending', amountCents: 500 });
    const approvalPath = `refund-approvals/${approval.id}/approve`;
    expect((await post(approvalPath, token, false)).status).toBe(403);
    expect((await post(approvalPath, approverToken, false)).status).toBe(403);
    await database
      .updateTable('sessions')
      .set({ elevated_until: new Date(now.getTime() + 15 * 60 * 1000) })
      .where('id', '=', approverSessionId)
      .execute();
    expect((await post(approvalPath, approverToken, false)).status).toBe(200);
    const executed = await post('refunds', token);
    const executedBody = refundResponseSchema.parse(
      (await executed.json()) as unknown,
    );
    expect(executed.status, JSON.stringify(executedBody)).toBe(201);
    expect(executedBody).toMatchObject({
      amountCents: 500,
      refundId: 're_route_second',
    });
    expect((await post('refunds', token)).status).toBe(201);
    expect(createRefund).toHaveBeenCalledTimes(2);
  });
});

describe('finance payout journal HTTP', () => {
  it('returns a balanced CSV only for an authorized reconciled payout', async () => {
    const payoutId = `po_${randomUUID().replaceAll('-', '')}`;
    const transactionId = `txn_${randomUUID().replaceAll('-', '')}`;
    const chargeId = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('payments')
        .select('stripe_charge_id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', paymentId)
        .executeTakeFirstOrThrow(),
    );
    if (!chargeId.stripe_charge_id)
      throw new Error('Payment charge is missing');
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('payouts')
        .values({
          id: newId(),
          org_id: context.orgId,
          stripe_payout_id: payoutId,
          amount_cents: 970,
          arrival_date: '2026-09-27',
          status: 'paid',
          balance_transaction_ids: [transactionId],
        })
        .execute();
      await trx
        .insertInto('balance_transactions')
        .values({
          id: newId(),
          org_id: context.orgId,
          stripe_balance_transaction_id: transactionId,
          stripe_payout_id: payoutId,
          type: 'charge',
          amount_cents: 1000,
          fee_cents: 30,
          net_cents: 970,
          source_id: chargeId.stripe_charge_id,
        })
        .execute();
    });
    const response = await fetch(
      `${baseUrl}/orgs/${context.orgId}/payouts/${payoutId}/journal-export`,
      {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: origin,
          'X-Athlentry-Request': '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bank: '1000',
          stripeClearing: '1010',
          processingFees: '6200',
          transactionTypes: { charge: '4000' },
        }),
      },
    );
    expect(response.status).toBe(200);
    const result = payoutJournalResponseSchema.parse(
      (await response.json()) as unknown,
    );
    expect(result.lineCount).toBe(5);
    expect(result.csv).toContain('Date,Journal No,Account,Debits,Credits');
    expect(result.csv).toContain('9.70');
  });
});

describe('signed-in payer method HTTP', () => {
  it('creates one test SetupIntent and manages only payer-attached methods', async () => {
    const headers = {
      Cookie: `__Host-athlentry_session=${token}`,
      Origin: origin,
      'X-Athlentry-Request': '1',
      'Idempotency-Key': randomUUID(),
    };
    const blocked = await fetch(`${baseUrl}/me/setup-intents`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://attacker.example' },
    });
    expect(blocked.status).toBe(403);
    const setup = await fetch(`${baseUrl}/me/setup-intents`, {
      method: 'POST',
      headers,
    });
    expect(setup.status).toBe(201);
    expect(await setup.json()).toMatchObject({
      id: 'seti_route',
      clientSecret: 'seti_route_secret_test',
    });
    expect(createCustomer).toHaveBeenCalledTimes(1);
    const listed = await fetch(`${baseUrl}/me/payment-methods`, {
      headers: { Cookie: headers.Cookie },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      methods: [{ id: 'pm_route', last4: '4242' }],
    });
    const defaulted = await fetch(
      `${baseUrl}/me/payment-methods/pm_route/default`,
      {
        method: 'POST',
        headers,
      },
    );
    expect(defaulted.status).toBe(200);
    expect(setDefaultPaymentMethod).toHaveBeenCalledWith(
      'cus_route',
      'pm_route',
    );
    const removed = await fetch(`${baseUrl}/me/payment-methods/pm_route`, {
      method: 'DELETE',
      headers,
    });
    expect(removed.status).toBe(200);
    expect(detachPaymentMethod).toHaveBeenCalledWith('pm_route');
  });
});
