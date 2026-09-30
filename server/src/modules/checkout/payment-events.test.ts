import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type {
  GatewayPaymentIntent,
  PaymentsGateway,
} from '../../integrations/stripe/gateway.js';
import { parseStripeWebhookEvent } from '../../integrations/stripe/webhooks.js';
import { PostgresInvoiceRepository } from '../finance/invoice-repo.js';
import { PostgresPaymentEventRepository } from '../finance/payment-event-repo.js';
import { PaymentIntentEventService } from '../finance/payment-events.js';
import { PostgresPaymentRecordStore } from '../finance/payment-repo.js';

import { PostgresCheckoutHoldRepository } from './capacity-repo.js';
import { CheckoutPaymentEventService } from './payment-events.js';
import { CheckoutService } from './service.js';
import { bindFixtureInvoice } from './test-fixtures.js';

let database: Kysely<DB>;
let context: OrgContext;
let checkoutId: string;
let invoiceId: string;
let paymentIntentId: string;
let current: GatewayPaymentIntent;
let service: PaymentIntentEventService;
const instant = Temporal.Instant.from('2026-09-26T12:00:00Z');

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const orgId = newId();
  const accountId = newId();
  checkoutId = newId();
  paymentIntentId = `pi_${randomUUID()}`;
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `checkout-webhook-${randomUUID()}@example.invalid`,
      first_name: 'Checkout',
      last_name: 'Webhook',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `checkout-webhook-${randomUUID().slice(0, 12)}`,
      name: 'Checkout Webhook Test',
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
  const subjects = [
    { subject: 'program' as const, id: newId(), quantity: 1 },
    { subject: 'division' as const, id: newId(), quantity: 1 },
    { subject: 'offering' as const, id: newId(), quantity: 1 },
  ];
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        org_id: orgId,
        account_id: accountId,
        status: 'awaiting_payment',
        expires_at: new Date('2026-09-26T12:20:00Z'),
        pricing_snapshot: { totalCents: 1000 },
      })
      .execute();
    for (const subject of subjects) {
      await trx
        .insertInto('capacity_counters')
        .values({
          id: newId(),
          org_id: orgId,
          subject_type: subject.subject,
          subject_id: subject.id,
          capacity: 1,
        })
        .onConflict((oc) =>
          oc
            .columns(['org_id', 'subject_type', 'subject_id'])
            .doUpdateSet((eb) => ({
              capacity: eb.ref('excluded.capacity'),
              confirmed: eb.ref('excluded.confirmed'),
              held: eb.ref('excluded.held'),
            })),
        )
        .execute();
    }
  });
  const capacity = new PostgresCheckoutHoldRepository(
    database,
    context,
    () => instant,
  );
  await capacity.reserve({
    orgId,
    checkoutId,
    subjects,
    expiresAt: '2026-09-26T12:20:00Z',
    idempotencyKey: randomUUID(),
  });
  await bindFixtureInvoice(database, context, checkoutId, invoiceId);
  await new PostgresPaymentRecordStore(database, context).recordPending({
    orgId,
    checkoutId,
    invoiceId,
    accountId,
    paymentIntentId,
    amountCents: 1000,
    applicationFeeCents: 10,
    idempotencyKey: randomUUID(),
  });
  const checkout = new CheckoutService(
    capacity,
    {
      create: () =>
        Promise.reject(new Error('Payment creation is not part of this test')),
    },
    {
      createRefund: vi.fn<PaymentsGateway['createRefund']>(() =>
        Promise.resolve({
          id: 're_test',
          status: 'pending',
          amountCents: 1000,
        }),
      ),
    },
  );
  const coordinator = new CheckoutPaymentEventService(
    database,
    accountId,
    capacity,
    checkout,
    () => instant,
  );
  current = {
    id: paymentIntentId,
    clientSecret: null,
    status: 'processing',
    amountCents: 1000,
    latestChargeId: null,
    method: 'us_bank_account',
  };
  service = new PaymentIntentEventService(
    new PostgresPaymentEventRepository(database, accountId, () => instant),
    { retrievePaymentIntent: () => Promise.resolve(current) },
    coordinator,
  );
});

afterAll(async () => {
  await database.destroy();
});

function event(type: string) {
  return parseStripeWebhookEvent({
    id: `evt_${randomUUID()}`,
    object: 'event',
    type,
    livemode: false,
    created: 1_700_000_000,
    data: {
      object: {
        id: paymentIntentId,
        object: 'payment_intent',
        metadata: { org_id: context.orgId },
      },
    },
  });
}

async function state() {
  return createWithOrg(database)(context, async (trx) => ({
    checkout: await trx
      .selectFrom('checkouts')
      .select(['status', 'expires_at'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', checkoutId)
      .executeTakeFirstOrThrow(),
    invoice: await trx
      .selectFrom('invoices')
      .select(['status', 'paid_cents'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow(),
    counters: await trx
      .selectFrom('capacity_counters')
      .select(['held', 'confirmed'])
      .where('org_id', '=', context.orgId)
      .execute(),
  }));
}

describe('PaymentIntent webhook checkout lifecycle', () => {
  it('confirms an ACH processing seat without counting invoice payment', async () => {
    expect(await service.handle(event('payment_intent.processing'))).toBe(
      'applied',
    );
    const snapshot = await state();
    expect(snapshot.checkout.status).toBe('completed');
    expect(snapshot.invoice).toEqual({ status: 'open', paid_cents: 0 });
    expect(
      snapshot.counters.every(
        (counter) => counter.held === 0 && counter.confirmed === 1,
      ),
    ).toBe(true);
  });

  it('restores a 72-hour hold after ACH failure, then settles a later success once', async () => {
    current = { ...current, status: 'requires_payment_method' };
    expect(await service.handle(event('payment_intent.payment_failed'))).toBe(
      'applied',
    );
    const failed = await state();
    expect(failed.checkout.status).toBe('awaiting_payment');
    expect(failed.checkout.expires_at.toISOString()).toBe(
      '2026-09-29T12:00:00.000Z',
    );
    expect(
      failed.counters.every(
        (counter) => counter.held === 1 && counter.confirmed === 0,
      ),
    ).toBe(true);
    await new PostgresCheckoutHoldRepository(
      database,
      context,
      () => instant,
    ).keepForFailedPayment({
      orgId: context.orgId,
      checkoutId,
      expiresAt: '2026-10-02T12:00:00Z',
    });
    expect((await state()).checkout.expires_at.toISOString()).toBe(
      '2026-09-29T12:00:00.000Z',
    );
    current = {
      ...current,
      status: 'succeeded',
      latestChargeId: `ch_${randomUUID()}`,
    };
    expect(await service.handle(event('payment_intent.succeeded'))).toBe(
      'applied',
    );
    expect(await service.handle(event('payment_intent.succeeded'))).toBe(
      'unchanged',
    );
    const succeeded = await state();
    expect(succeeded.checkout.status).toBe('completed');
    expect(succeeded.invoice).toEqual({ status: 'paid', paid_cents: 1000 });
    expect(
      succeeded.counters.every(
        (counter) => counter.held === 0 && counter.confirmed === 1,
      ),
    ).toBe(true);
  });
});
