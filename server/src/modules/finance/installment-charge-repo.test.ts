import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { FakeEmailSender } from '../../integrations/email/sender.js';

import { PostgresInstallmentChargeRepository } from './installment-charge-repo.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';
import { deliverFinanceNotices } from './money-notice-job.js';
import { PostgresPaymentEventRepository } from './payment-event-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let installmentId: string;
let repo: PostgresInstallmentChargeRepository;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  installmentId = newId();
  const methodId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `dunning-${randomUUID()}@example.invalid`,
      first_name: 'Dunning',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `dunning-${randomUUID().slice(0, 12)}`,
      name: 'Dunning Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
      application_fee_bps: 150,
    })
    .execute();
  context = { orgId, actor: { accountId } };
  const invoice = await new PostgresInvoiceRepository(database, context).issue({
    orgId,
    accountId,
    source: 'tuition',
    creationKey: randomUUID(),
    lines: [
      {
        kind: 'tuition',
        description: 'Tuition',
        amountCents: 1000,
        refundable: true,
      },
    ],
  });
  await database
    .insertInto('payer_profiles')
    .values({
      id: newId(),
      account_id: accountId,
      stripe_customer_id: 'cus_test_dunning',
    })
    .execute();
  await database
    .insertInto('payment_methods')
    .values({
      id: methodId,
      account_id: accountId,
      stripe_payment_method_id: 'pm_test_dunning',
      type: 'card',
      status: 'active',
    })
    .execute();
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('payment_accounts')
      .values({
        id: newId(),
        org_id: orgId,
        stripe_account_id: 'acct_test_dunning',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        onboarding_status: 'active',
      })
      .execute();
    await trx
      .insertInto('installments')
      .values({
        id: installmentId,
        org_id: orgId,
        invoice_id: invoice.id,
        sequence: 1,
        due_on: '2026-09-26',
        amount_cents: 1000,
        autopay: true,
        payment_method_id: methodId,
      })
      .execute();
    await trx
      .insertInto('autopay_authorizations')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        payment_method_id: methodId,
        invoice_id: invoice.id,
        mandate_text_version: 'test-v1',
      })
      .execute();
  });
  repo = new PostgresInstallmentChargeRepository(database, accountId);
});

afterAll(async () => {
  await database.destroy();
});

describe('durable installment charges', () => {
  it('claims only at 10:00 org local and fences stale leases', async () => {
    expect(
      await repo.claimDue(context.orgId, '2026-09-26T14:59:59Z'),
    ).toBeNull();
    const first = await repo.claimDue(context.orgId, '2026-09-26T15:00:00Z');
    if (!first) throw new Error('Installment was not claimed');
    expect(first).toMatchObject({
      orgId: context.orgId,
      installmentId,
      attemptNumber: 1,
      amountCents: 1000,
      applicationFeeCents: 15,
      customerId: 'cus_test_dunning',
      connectedAccountId: 'acct_test_dunning',
      paymentMethodId: 'pm_test_dunning',
      method: 'card',
    });
    expect(
      await repo.claimDue(context.orgId, '2026-09-26T15:00:01Z'),
    ).toBeNull();
    const resumed = await repo.claimDue(context.orgId, '2026-09-26T15:06:00Z');
    expect(resumed?.id).toBe(first.id);
    expect(resumed?.leaseToken).not.toBe(first.leaseToken);
    await expect(repo.beginExternal(first)).rejects.toThrow('stale');
    if (!resumed) throw new Error('Installment lease was not resumed');
    await repo.beginExternal(resumed);
    await repo.recordIntent(resumed, 'pi_test_dunning_1');
    await expect(
      repo.recordIntent(resumed, 'pi_test_dunning_1'),
    ).rejects.toThrow('changed');
    const stored = await createWithOrg(database)(context, async (trx) => ({
      payments: await trx
        .selectFrom('payments')
        .select(['status', 'method', 'amount_cents'])
        .where('org_id', '=', context.orgId)
        .where('stripe_payment_intent_id', '=', 'pi_test_dunning_1')
        .execute(),
      allocations: await trx
        .selectFrom('payment_allocations')
        .select(['installment_id', 'amount_cents'])
        .where('org_id', '=', context.orgId)
        .where('installment_id', '=', installmentId)
        .execute(),
    }));
    expect(stored.payments).toEqual([
      { status: 'requires_action', method: 'card', amount_cents: 1000 },
    ]);
    expect(stored.allocations).toEqual([
      { installment_id: installmentId, amount_cents: 1000 },
    ]);
  });

  it('retries after one and three days, then settles the third charge', async () => {
    const firstFailure = new PostgresPaymentEventRepository(
      database,
      context.actor.accountId,
      () => Temporal.Instant.from('2026-09-26T16:00:00Z'),
    );
    await firstFailure.applyLatest({
      orgId: context.orgId,
      paymentIntentId: 'pi_test_dunning_1',
      latest: {
        id: 'pi_test_dunning_1',
        clientSecret: null,
        status: 'requires_payment_method',
        amountCents: 1000,
        latestChargeId: null,
        method: 'card',
        failureCode: 'do_not_honor',
      },
    });
    const afterFirst = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('installments')
        .select(['status', 'autopay', 'next_attempt_at'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', installmentId)
        .executeTakeFirstOrThrow(),
    );
    expect(afterFirst.status).toBe('failed');
    expect(afterFirst.autopay).toBe(true);
    expect(afterFirst.next_attempt_at?.toISOString()).toBe(
      '2026-09-27T15:00:00.000Z',
    );
    expect(
      await repo.claimDue(context.orgId, '2026-09-27T14:59:59Z'),
    ).toBeNull();
    const second = await repo.claimDue(context.orgId, '2026-09-27T15:00:00Z');
    if (!second) throw new Error('Second installment attempt missing');
    expect(second.attemptNumber).toBe(2);
    await repo.beginExternal(second);
    await repo.recordIntent(second, 'pi_test_dunning_2');
    const secondFailure = new PostgresPaymentEventRepository(
      database,
      context.actor.accountId,
      () => Temporal.Instant.from('2026-09-27T16:00:00Z'),
    );
    await secondFailure.applyLatest({
      orgId: context.orgId,
      paymentIntentId: 'pi_test_dunning_2',
      latest: {
        id: 'pi_test_dunning_2',
        clientSecret: null,
        status: 'requires_payment_method',
        amountCents: 1000,
        latestChargeId: null,
        method: 'card',
        failureCode: 'do_not_honor',
      },
    });
    const afterSecond = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('installments')
        .select('next_attempt_at')
        .where('org_id', '=', context.orgId)
        .where('id', '=', installmentId)
        .executeTakeFirstOrThrow(),
    );
    expect(afterSecond.next_attempt_at?.toISOString()).toBe(
      '2026-09-30T15:00:00.000Z',
    );
    const failureNotices = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('finance_notice_outbox')
        .select(['kind', 'source_id'])
        .where('org_id', '=', context.orgId)
        .where('kind', '=', 'installment_failed')
        .orderBy('source_id')
        .execute(),
    );
    expect(failureNotices).toHaveLength(2);
    const sender = new FakeEmailSender();
    await deliverFinanceNotices({
      database,
      sender,
      appUrl: 'http://127.0.0.1:5173',
      organizationIds: [context.orgId],
    });
    const failureEmails = sender.messages.filter((message) =>
      message.subject.includes('installment payment failed'),
    );
    expect(failureEmails).toHaveLength(2);
    expect(
      failureEmails.every(
        (message) =>
          message.text.includes(
            `/portal/orgs/${context.orgId}/money/installments`,
          ) && message.attachments === undefined,
      ),
    ).toBe(true);
    const third = await repo.claimDue(context.orgId, '2026-09-30T15:00:00Z');
    if (!third) throw new Error('Third installment attempt missing');
    expect(third.attemptNumber).toBe(3);
    await repo.beginExternal(third);
    await repo.recordIntent(third, 'pi_test_dunning_3');
    const settlement = new PostgresPaymentEventRepository(
      database,
      context.actor.accountId,
      () => Temporal.Instant.from('2026-09-30T16:00:00Z'),
    );
    await settlement.applyLatest({
      orgId: context.orgId,
      paymentIntentId: 'pi_test_dunning_3',
      latest: {
        id: 'pi_test_dunning_3',
        clientSecret: null,
        status: 'succeeded',
        amountCents: 1000,
        latestChargeId: 'ch_test_dunning_3',
        method: 'card',
      },
    });
    const final = await createWithOrg(database)(context, async (trx) => ({
      installment: await trx
        .selectFrom('installments')
        .select(['status', 'paid_cents', 'next_attempt_at'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', installmentId)
        .executeTakeFirstOrThrow(),
      invoice: await trx
        .selectFrom('invoices')
        .select(['status', 'paid_cents'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', third.invoiceId)
        .executeTakeFirstOrThrow(),
    }));
    expect(final.installment).toEqual({
      status: 'paid',
      paid_cents: 1000,
      next_attempt_at: null,
    });
    expect(final.invoice).toEqual({ status: 'paid', paid_cents: 1000 });
  });

  it('stops automatic retries when the card must be replaced', async () => {
    const method = await database
      .selectFrom('payment_methods')
      .select('id')
      .where('stripe_payment_method_id', '=', 'pm_test_dunning')
      .executeTakeFirstOrThrow();
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'tuition',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'tuition',
          description: 'October tuition',
          amountCents: 500,
          refundable: true,
        },
      ],
    });
    const another = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('installments')
        .values({
          id: another,
          org_id: context.orgId,
          invoice_id: invoice.id,
          sequence: 1,
          due_on: '2026-10-05',
          amount_cents: 500,
          autopay: true,
          payment_method_id: method.id,
        })
        .execute();
      await trx
        .insertInto('autopay_authorizations')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: context.actor.accountId,
          payment_method_id: method.id,
          invoice_id: invoice.id,
          mandate_text_version: 'test-v1',
        })
        .execute();
    });
    const attempt = await repo.claimDue(context.orgId, '2026-10-05T15:00:00Z');
    if (!attempt) throw new Error('October installment was not claimed');
    expect(attempt.installmentId).toBe(another);
    await repo.beginExternal(attempt);
    await repo.recordIntent(attempt, 'pi_test_expired_card');
    await new PostgresPaymentEventRepository(
      database,
      context.actor.accountId,
      () => Temporal.Instant.from('2026-10-05T16:00:00Z'),
    ).applyLatest({
      orgId: context.orgId,
      paymentIntentId: 'pi_test_expired_card',
      latest: {
        id: 'pi_test_expired_card',
        clientSecret: null,
        status: 'requires_payment_method',
        amountCents: 500,
        latestChargeId: null,
        method: 'card',
        failureCode: 'expired_card',
      },
    });
    const stopped = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('installments')
        .select(['status', 'autopay', 'next_attempt_at'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', another)
        .executeTakeFirstOrThrow(),
    );
    expect(stopped).toEqual({
      status: 'failed',
      autopay: false,
      next_attempt_at: null,
    });
    const finalNotice = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('finance_notice_outbox')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('kind', '=', 'installment_final_notice')
        .execute(),
    );
    expect(finalNotice).toHaveLength(1);
    expect(
      await repo.claimDue(context.orgId, '2026-10-06T15:00:00Z'),
    ).toBeNull();
  });

  it('notifies finance once when an ACH installment fails after processing', async () => {
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'tuition',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'tuition',
          description: 'ACH tuition',
          amountCents: 400,
          refundable: true,
        },
      ],
    });
    const methodId = newId();
    const achInstallmentId = newId();
    const financeId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: financeId,
        email: `ach-finance-${randomUUID()}@example.invalid`,
        first_name: 'ACH',
        last_name: 'Finance',
        date_of_birth: '1990-01-01',
      })
      .execute();
    await database
      .insertInto('payment_methods')
      .values({
        id: methodId,
        account_id: context.actor.accountId,
        stripe_payment_method_id: `pm_${randomUUID()}`,
        type: 'us_bank_account',
        status: 'active',
      })
      .execute();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: financeId,
          status: 'active',
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: financeId,
          role: 'finance',
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
      await trx
        .insertInto('installments')
        .values({
          id: achInstallmentId,
          org_id: context.orgId,
          invoice_id: invoice.id,
          sequence: 1,
          due_on: '2026-10-07',
          amount_cents: 400,
          autopay: true,
          payment_method_id: methodId,
        })
        .execute();
      await trx
        .insertInto('autopay_authorizations')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: context.actor.accountId,
          payment_method_id: methodId,
          invoice_id: invoice.id,
          mandate_text_version: 'test-v1',
        })
        .execute();
    });
    const claim = await repo.claimDue(context.orgId, '2026-10-07T15:00:00Z');
    if (!claim || claim.installmentId !== achInstallmentId)
      throw new Error('ACH installment was not claimed');
    await repo.beginExternal(claim);
    const intentId = `pi_${randomUUID()}`;
    await repo.recordIntent(claim, intentId);
    const events = new PostgresPaymentEventRepository(
      database,
      context.actor.accountId,
      () => Temporal.Instant.from('2026-10-07T16:00:00Z'),
    );
    const latest = {
      id: intentId,
      clientSecret: null,
      amountCents: 400,
      latestChargeId: null,
      method: 'us_bank_account' as const,
    };
    await events.applyLatest({
      orgId: context.orgId,
      paymentIntentId: intentId,
      latest: { ...latest, status: 'processing' },
    });
    await events.applyLatest({
      orgId: context.orgId,
      paymentIntentId: intentId,
      latest: {
        ...latest,
        status: 'requires_payment_method',
        failureCode: 'ach_return',
      },
    });
    await events.applyLatest({
      orgId: context.orgId,
      paymentIntentId: intentId,
      latest: {
        ...latest,
        status: 'requires_payment_method',
        failureCode: 'ach_return',
      },
    });
    const notices = await createWithOrg(database)(context, async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('stripe_payment_intent_id', '=', intentId)
        .executeTakeFirstOrThrow();
      return sql<{ account_id: string }>`
        SELECT account_id FROM notifications
        WHERE org_id = ${context.orgId}::uuid
          AND type = 'installment.failed'
          AND payload->>'resourceId' = ${payment.id}
      `.execute(trx);
    });
    expect(notices.rows.map((notice) => notice.account_id).sort()).toEqual(
      [context.actor.accountId, financeId].sort(),
    );
  });
});
