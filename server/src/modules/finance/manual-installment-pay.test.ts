import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';

import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresManualInstallmentPayments } from './manual-installment-pay.js';
import { PostgresPaymentEventRepository } from './payment-event-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let installmentId: string;
let invoiceId: string;
let outsiderAccountId: string;
const paymentIntentId = 'pi_test_manual_installment';
const gateway = {
  retrieveAccount: vi.fn<PaymentsGateway['retrieveAccount']>(() =>
    Promise.resolve({
      id: 'acct_test_manual_installment',
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirements: { currentlyDue: [], disabledReason: null },
    }),
  ),
  createDestinationPayment: vi.fn<PaymentsGateway['createDestinationPayment']>(
    () =>
      Promise.resolve({
        id: paymentIntentId,
        clientSecret: 'pi_test_manual_secret',
        status: 'requires_payment_method',
        amountCents: 1000,
        latestChargeId: null,
      }),
  ),
};

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  outsiderAccountId = newId();
  const orgId = newId();
  installmentId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `manual-inst-${randomUUID()}@example.invalid`,
      first_name: 'Manual',
      last_name: 'Payer',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('accounts')
    .values({
      id: outsiderAccountId,
      email: `manual-outsider-${randomUUID()}@example.invalid`,
      first_name: 'Other',
      last_name: 'Payer',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `manual-inst-${randomUUID().slice(0, 12)}`,
      name: 'Manual Installment Test',
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
  invoiceId = invoice.id;
  await database
    .insertInto('payer_profiles')
    .values({
      id: newId(),
      account_id: accountId,
      stripe_customer_id: 'cus_test_manual_installment',
    })
    .execute();
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('payment_accounts')
      .values({
        id: newId(),
        org_id: orgId,
        stripe_account_id: 'acct_test_manual_installment',
        charges_enabled: true,
        onboarding_status: 'active',
      })
      .execute();
    await trx
      .insertInto('installments')
      .values({
        id: installmentId,
        org_id: orgId,
        invoice_id: invoiceId,
        sequence: 1,
        due_on: '2026-10-01',
        amount_cents: 1000,
      })
      .execute();
  });
});
afterAll(async () => {
  await database.destroy();
});

describe('payer-initiated installment PaymentIntent', () => {
  it('allocates cents before Stripe, fences another key and replays one intent', async () => {
    const service = new PostgresManualInstallmentPayments(
      database,
      context,
      gateway,
    );
    const key = randomUUID();
    const result = await service.create(installmentId, key);
    expect(result).toMatchObject({
      id: paymentIntentId,
      amountCents: 1000,
      applicationFeeCents: 15,
    });
    expect(gateway.createDestinationPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        installmentId,
        invoiceId,
        amountCents: 1000,
        applicationFeeCents: 15,
        saveForAutopay: false,
        idempotencyKey: `manual-inst:${installmentId}:${key}`,
      }),
    );
    expect(await service.create(installmentId, key)).toEqual(result);
    expect(gateway.createDestinationPayment).toHaveBeenCalledOnce();
    await expect(service.create(installmentId, randomUUID())).rejects.toThrow(
      'already in progress',
    );
    const stored = await createWithOrg(database)(context, async (trx) => ({
      payment: await trx
        .selectFrom('payments')
        .select(['id', 'status', 'amount_cents', 'stripe_payment_intent_id'])
        .where('org_id', '=', context.orgId)
        .where('stripe_payment_intent_id', '=', paymentIntentId)
        .executeTakeFirstOrThrow(),
      allocation: await trx
        .selectFrom('payment_allocations')
        .select(['installment_id', 'invoice_id', 'amount_cents'])
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', invoiceId)
        .executeTakeFirstOrThrow(),
    }));
    expect(stored.payment).toMatchObject({
      status: 'requires_action',
      amount_cents: 1000,
    });
    expect(stored.allocation).toMatchObject({
      installment_id: installmentId,
      invoice_id: invoiceId,
      amount_cents: 1000,
    });
    expect(await service.listPayable()).toEqual({ installments: [] });
  });

  it('keeps manual card failure out of off-session dunning', async () => {
    await new PostgresPaymentEventRepository(
      database,
      context.actor.accountId,
    ).applyLatest({
      orgId: context.orgId,
      paymentIntentId,
      latest: {
        id: paymentIntentId,
        clientSecret: null,
        status: 'requires_payment_method',
        amountCents: 1000,
        latestChargeId: null,
        method: 'card',
        failureCode: 'card_declined',
      },
    });
    const installment = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('installments')
        .select(['status', 'attempt_count', 'autopay'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', installmentId)
        .executeTakeFirstOrThrow(),
    );
    expect(installment).toMatchObject({
      status: 'scheduled',
      attempt_count: 0,
      autopay: false,
    });
  });

  it('allows a new exact claim after failure and settles success once', async () => {
    const nextId = 'pi_test_manual_second';
    gateway.createDestinationPayment.mockResolvedValueOnce({
      id: nextId,
      clientSecret: 'pi_test_manual_second_secret',
      status: 'requires_payment_method',
      amountCents: 1000,
      latestChargeId: null,
    });
    const service = new PostgresManualInstallmentPayments(
      database,
      context,
      gateway,
    );
    expect(await service.listPayable()).toMatchObject({
      installments: [{ id: installmentId, outstandingCents: 1000 }],
    });
    const created = await service.create(installmentId, randomUUID());
    expect(created.id).toBe(nextId);
    const events = new PostgresPaymentEventRepository(
      database,
      context.actor.accountId,
    );
    const latest = {
      id: nextId,
      clientSecret: null,
      status: 'succeeded',
      amountCents: 1000,
      latestChargeId: 'ch_test_manual_second',
      method: 'card' as const,
    };
    expect(
      await events.applyLatest({
        orgId: context.orgId,
        paymentIntentId: nextId,
        latest,
      }),
    ).toBe('applied');
    expect(
      await events.applyLatest({
        orgId: context.orgId,
        paymentIntentId: nextId,
        latest,
      }),
    ).toBe('unchanged');
    const state = await createWithOrg(database)(context, async (trx) => ({
      installment: await trx
        .selectFrom('installments')
        .select(['status', 'paid_cents', 'attempt_count'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', installmentId)
        .executeTakeFirstOrThrow(),
      invoice: await trx
        .selectFrom('invoices')
        .select(['status', 'paid_cents', 'balance_cents'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', invoiceId)
        .executeTakeFirstOrThrow(),
    }));
    expect(state.installment).toMatchObject({
      status: 'paid',
      paid_cents: 1000,
      attempt_count: 0,
    });
    expect(state.invoice).toMatchObject({
      status: 'paid',
      paid_cents: 1000,
      balance_cents: 0,
    });
  });

  it('rejects another payer and releases only a pre-external failed claim', async () => {
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
          description: 'Another tuition',
          amountCents: 500,
          refundable: true,
        },
      ],
    });
    const targetId = newId();
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('installments')
        .values({
          id: targetId,
          org_id: context.orgId,
          invoice_id: invoice.id,
          sequence: 1,
          due_on: '2026-10-02',
          amount_cents: 500,
        })
        .execute(),
    );
    const outsider = new PostgresManualInstallmentPayments(
      database,
      { orgId: context.orgId, actor: { accountId: outsiderAccountId } },
      gateway,
    );
    await expect(outsider.create(targetId, randomUUID())).rejects.toThrow(
      'another payer',
    );
    const payer = new PostgresManualInstallmentPayments(
      database,
      context,
      gateway,
    );
    gateway.retrieveAccount.mockResolvedValueOnce({
      id: 'acct_test_manual_installment',
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: true,
      requirements: { currentlyDue: [], disabledReason: 'disabled' },
    });
    await expect(payer.create(targetId, randomUUID())).rejects.toThrow(
      'cannot charge',
    );
    expect(await payer.listPayable()).toMatchObject({
      installments: [{ id: targetId, outstandingCents: 500 }],
    });
    gateway.createDestinationPayment.mockResolvedValueOnce({
      id: 'pi_test_manual_recovered',
      clientSecret: 'pi_test_manual_recovered_secret',
      status: 'requires_payment_method',
      amountCents: 500,
      latestChargeId: null,
    });
    expect(await payer.create(targetId, randomUUID())).toMatchObject({
      amountCents: 500,
      applicationFeeCents: 8,
    });
  });

  it('allows only one concurrent key to create a charge', async () => {
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
          description: 'Concurrent tuition',
          amountCents: 700,
          refundable: true,
        },
      ],
    });
    const targetId = newId();
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('installments')
        .values({
          id: targetId,
          org_id: context.orgId,
          invoice_id: invoice.id,
          sequence: 1,
          due_on: '2026-10-03',
          amount_cents: 700,
        })
        .execute(),
    );
    const createDestinationPayment = vi.fn<
      PaymentsGateway['createDestinationPayment']
    >(() =>
      Promise.resolve({
        id: 'pi_test_manual_concurrent',
        clientSecret: 'pi_test_manual_concurrent_secret',
        status: 'requires_payment_method',
        amountCents: 700,
        latestChargeId: null,
      }),
    );
    const service = new PostgresManualInstallmentPayments(database, context, {
      retrieveAccount: gateway.retrieveAccount,
      createDestinationPayment,
    });
    const results = await Promise.allSettled([
      service.create(targetId, randomUUID()),
      service.create(targetId, randomUUID()),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(createDestinationPayment).toHaveBeenCalledOnce();
  });
});
