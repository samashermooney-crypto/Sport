import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { bindFixtureInvoice } from '../checkout/test-fixtures.js';

import { PostgresCreditRefundRepository } from './credit-refund-repo.js';
import { PostgresCreditLedger } from './credits.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresPaymentEventRepository } from './payment-event-repo.js';
import { PostgresPaymentRecordStore } from './payment-repo.js';
import { PostgresRefundAttemptStore } from './refund-attempt-repo.js';
import { PostgresRefundEventRepository } from './refund-event-repo.js';
import { PostgresRefundRecordStore } from './refund-record-repo.js';
import { PostgresRefundSourceReader } from './refund-source-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let paymentId: string;
let registrationLineId: string;
let repo: PostgresRefundRecordStore;

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
      email: `refund-record-${randomUUID()}@example.invalid`,
      first_name: 'Refund',
      last_name: 'Record',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `refund-record-${randomUUID().slice(0, 12)}`,
      name: 'Refund Record Test',
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
    refundTerms: {
      policy: {
        rules: [],
        afterLastBps: 10_000,
        serviceFeeRefund: 'proportional',
      },
      approvalThresholdCents: 1000,
      refundApplicationFee: true,
    },
    lines: [
      {
        kind: 'registration',
        description: 'Registration',
        amountCents: 900,
        refundable: true,
      },
      {
        kind: 'service_fee',
        description: 'Service fee',
        amountCents: 100,
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
  await bindFixtureInvoice(database, context, checkoutId, invoice.id);
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
    Temporal.Instant.from('2026-09-26T12:00:00Z'),
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
  const setup = await createWithOrg(database)(context, async (trx) => ({
    payment: await trx
      .selectFrom('payments')
      .select('id')
      .where('org_id', '=', orgId)
      .where('stripe_payment_intent_id', '=', paymentIntentId)
      .executeTakeFirstOrThrow(),
    line: await trx
      .selectFrom('invoice_lines')
      .select('id')
      .where('org_id', '=', orgId)
      .where('invoice_id', '=', invoice.id)
      .where('kind', '=', 'registration')
      .executeTakeFirstOrThrow(),
  }));
  paymentId = setup.payment.id;
  registrationLineId = setup.line.id;
  repo = new PostgresRefundRecordStore(database, context);
});

afterAll(async () => {
  await database.destroy();
});

function request(refundId = `re_${randomUUID()}`) {
  return {
    orgId: context.orgId,
    paymentId,
    refundId,
    proposal: {
      lines: [{ lineId: registrationLineId, amountCents: 450 }],
      serviceFeeCents: 50,
      totalCents: 500,
      refundBps: 10_000,
    },
    requestedByAccountId: context.actor.accountId,
    approvedByAccountId: null,
    refundApplicationFee: true,
  };
}

describe('pending Stripe refund records', () => {
  it('records line and service-fee allocations once before settlement', async () => {
    const sourceReader = new PostgresRefundSourceReader(database, context);
    const source = await sourceReader.load(context.orgId, paymentId);
    expect(source).toMatchObject({
      paymentStatus: 'succeeded',
      paidServiceFeeCents: 100,
      previouslyRefundedServiceFeeCents: 0,
      lines: [
        { id: registrationLineId, paidCents: 900, previouslyRefundedCents: 0 },
      ],
    });
    const input = request();
    await repo.recordPending(input);
    await repo.recordPending(input);
    const state = await createWithOrg(database)(context, async (trx) => ({
      refund: await trx
        .selectFrom('refunds')
        .select(['id', 'status', 'amount_cents', 'refund_application_fee'])
        .where('org_id', '=', context.orgId)
        .where('stripe_refund_id', '=', input.refundId)
        .executeTakeFirstOrThrow(),
      invoice: await trx
        .selectFrom('invoices')
        .select(['paid_cents', 'refunded_cents'])
        .where('org_id', '=', context.orgId)
        .executeTakeFirstOrThrow(),
    }));
    expect(state.refund).toMatchObject({
      status: 'pending',
      amount_cents: 500,
      refund_application_fee: true,
    });
    expect(state.invoice).toEqual({ paid_cents: 1000, refunded_cents: 0 });
    const allocations = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('refund_allocations')
        .select('amount_cents')
        .where('org_id', '=', context.orgId)
        .where('refund_id', '=', state.refund.id)
        .execute(),
    );
    expect(
      allocations.map((row) => row.amount_cents).sort((a, b) => a - b),
    ).toEqual([50, 450]);
    const settlements = new PostgresRefundEventRepository(
      database,
      context.actor.accountId,
      () => Temporal.Instant.from('2026-09-26T12:00:00Z'),
    );
    const financeAccountId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: financeAccountId,
        email: `refund-finance-${randomUUID()}@example.invalid`,
        first_name: 'Finance',
        last_name: 'Reviewer',
        date_of_birth: '1990-01-01',
      })
      .execute();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: financeAccountId,
          status: 'active',
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: financeAccountId,
          role: 'finance',
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
    });
    const latest = {
      id: input.refundId,
      status: 'succeeded',
      amountCents: 500,
      paymentIntentId: null,
      orgId: context.orgId,
    };
    expect(
      await settlements.applyLatest({ orgId: context.orgId, refund: latest }),
    ).toBe('applied');
    expect(
      await settlements.applyLatest({ orgId: context.orgId, refund: latest }),
    ).toBe('unchanged');
    const notifications = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('notifications')
        .select('account_id')
        .where('org_id', '=', context.orgId)
        .where('type', '=', 'refund.issued')
        .execute(),
    );
    expect(notifications.map((row) => row.account_id).sort()).toEqual(
      [context.actor.accountId, financeAccountId].sort(),
    );
    const settled = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('invoices')
        .select(['status', 'refunded_cents', 'balance_cents'])
        .where('org_id', '=', context.orgId)
        .executeTakeFirstOrThrow(),
    );
    expect(settled).toEqual({
      status: 'partially_paid',
      refunded_cents: 500,
      balance_cents: 500,
    });
    const refundClock = await createWithOrg(database)(context, (trx) =>
      sql<{ succeeded_at: Date }>`
        SELECT succeeded_at FROM refunds
        WHERE org_id = ${context.orgId}::uuid
          AND stripe_refund_id = ${input.refundId}
      `.execute(trx),
    );
    expect(refundClock.rows[0]?.succeeded_at.toISOString()).toBe(
      '2026-09-26T12:00:00.000Z',
    );
    expect(await sourceReader.load(context.orgId, paymentId)).toMatchObject({
      previouslyRefundedServiceFeeCents: 50,
      lines: [
        {
          id: registrationLineId,
          paidCents: 900,
          previouslyRefundedCents: 450,
        },
      ],
    });
  });

  it('rejects a second refund that would overrun the payment', async () => {
    await expect(
      repo.recordPending({
        ...request(),
        proposal: {
          lines: [{ lineId: registrationLineId, amountCents: 500 }],
          serviceFeeCents: 50,
          totalCents: 550,
          refundBps: 5556,
        },
      }),
    ).rejects.toThrow('exceed the successful payment');
  });

  it('reopens the invoice and issues credit atomically for the remaining refund', async () => {
    const credits = new PostgresCreditRefundRepository(database, context, () =>
      Temporal.Instant.from('2026-09-26T12:00:00Z'),
    );
    const input = {
      orgId: context.orgId,
      paymentId,
      cancellationDate: '2026-09-26',
      requestedByAccountId: context.actor.accountId,
      idempotencyKey: randomUUID(),
      recipient: 'account' as const,
    };
    const proposal = {
      lines: [{ lineId: registrationLineId, amountCents: 450 }],
      serviceFeeCents: 50,
      totalCents: 500,
      refundBps: 10_000,
    };
    const requestHash = 'a'.repeat(64);
    const attemptStore = new PostgresRefundAttemptStore(database, context);
    const attemptKey = randomUUID();
    expect(
      await attemptStore.reserve({
        orgId: context.orgId,
        paymentId,
        key: attemptKey,
        requestHash: 'c'.repeat(64),
      }),
    ).toEqual({ kind: 'reserved' });
    await expect(credits.apply(input, requestHash, proposal)).rejects.toThrow(
      'Original-method refund is in progress',
    );
    await attemptStore.fail({
      orgId: context.orgId,
      paymentId,
      key: attemptKey,
    });
    const result = await credits.apply(input, requestHash, proposal);
    expect(result.amountCents).toBe(500);
    expect(await credits.replay(input, requestHash)).toEqual(result);
    expect(await credits.apply(input, requestHash, proposal)).toEqual(result);
    await expect(credits.replay(input, 'b'.repeat(64))).rejects.toThrow(
      'conflicts',
    );
    const invoice = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('invoices')
        .select(['refunded_cents', 'balance_cents'])
        .where('org_id', '=', context.orgId)
        .executeTakeFirstOrThrow(),
    );
    expect(invoice).toEqual({ refunded_cents: 1000, balance_cents: 1000 });
    const creditRefundClock = await createWithOrg(database)(context, (trx) =>
      sql<{ succeeded_at: Date }>`
        SELECT succeeded_at FROM refunds
        WHERE org_id = ${context.orgId}::uuid
          AND credit_id = ${result.creditId}::uuid
      `.execute(trx),
    );
    expect(creditRefundClock.rows[0]?.succeeded_at.toISOString()).toBe(
      '2026-09-26T12:00:00.000Z',
    );
    expect(
      await new PostgresCreditLedger(database, context).balance({
        orgId: context.orgId,
        accountId: context.actor.accountId,
        todayLocal: '2026-09-26',
      }),
    ).toBe(500);
  });
});
