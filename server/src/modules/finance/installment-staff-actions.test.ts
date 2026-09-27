import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresInstallmentStaffActions } from './installment-staff-actions.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let installmentId: string;
let invoiceId: string;
let payerAccountId: string;
const now = () => Temporal.Instant.from('2026-09-27T15:00:00Z');

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  payerAccountId = accountId;
  const orgId = newId();
  installmentId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `staff-installment-${randomUUID()}@example.invalid`,
      first_name: 'Installment',
      last_name: 'Staff',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `staff-inst-${randomUUID().slice(0, 12)}`,
      name: 'Installment Staff Test',
      kind: 'club',
      timezone: 'America/Chicago',
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
  await createWithOrg(database)(context, (trx) =>
    trx
      .insertInto('installments')
      .values({
        id: installmentId,
        org_id: orgId,
        invoice_id: invoiceId,
        sequence: 1,
        due_on: '2026-10-01',
        amount_cents: 1000,
      })
      .execute(),
  );
});

afterAll(async () => {
  await database.destroy();
});

describe('staff installment schedule actions', () => {
  it('changes a due date once per key and rejects stale or reused keys', async () => {
    const repo = new PostgresInstallmentStaffActions(database, context, now);
    const key = randomUUID();
    const input = {
      action: 'change_due_date' as const,
      expectedVersion: 1,
      newDueOn: '2026-10-05',
      reason: 'Family requested a later date',
    };
    const changed = await repo.perform(installmentId, key, input);
    expect(changed).toMatchObject({
      version: 2,
      dueOn: '2026-10-05',
      amountCents: 1000,
      addedInstallmentId: null,
    });
    expect(await repo.perform(installmentId, key, input)).toEqual(changed);
    await expect(
      repo.perform(installmentId, key, {
        ...input,
        newDueOn: '2026-10-06',
      }),
    ).rejects.toThrow('key was reused');
    await expect(
      repo.perform(installmentId, randomUUID(), input),
    ).rejects.toThrow('version changed');
    await expect(
      repo.perform(installmentId, randomUUID(), {
        ...input,
        expectedVersion: 2,
        newDueOn: '2026-09-27',
      }),
    ).rejects.toThrow('future');
  });

  it('splits only an untouched installment while preserving plan cents', async () => {
    const repo = new PostgresInstallmentStaffActions(database, context, now);
    const result = await repo.perform(installmentId, randomUUID(), {
      action: 'split',
      expectedVersion: 2,
      splitCents: 300,
      newDueOn: '2026-10-20',
      reason: 'Approved family payment plan',
    });
    expect(result).toMatchObject({
      version: 3,
      amountCents: 700,
      addedAmountCents: 300,
    });
    const installments = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('installments')
        .select(['sequence', 'amount_cents', 'autopay', 'payment_method_id'])
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', invoiceId)
        .orderBy('sequence')
        .execute(),
    );
    expect(installments.map((row) => row.amount_cents)).toEqual([700, 300]);
    expect(installments[1]).toMatchObject({
      autopay: false,
      payment_method_id: null,
    });
    await expect(
      repo.perform(installmentId, randomUUID(), {
        action: 'split',
        expectedVersion: 3,
        splitCents: 100,
        newDueOn: '2026-10-19',
        reason: 'Another requested split',
      }),
    ).rejects.toThrow('final installment');
  });

  it('switches only to an active payer-owned method with invoice consent', async () => {
    const methodId = newId();
    const mandateId = newId();
    await database
      .insertInto('payment_methods')
      .values({
        id: methodId,
        account_id: payerAccountId,
        stripe_payment_method_id: `pm_${randomUUID()}`,
        type: 'card',
        status: 'active',
      })
      .execute();
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('autopay_authorizations')
        .values({
          id: mandateId,
          org_id: context.orgId,
          account_id: payerAccountId,
          invoice_id: invoiceId,
          payment_method_id: methodId,
          mandate_text_version: 'mandate-v1',
        })
        .execute(),
    );
    const repo = new PostgresInstallmentStaffActions(database, context, now);
    const action = {
      action: 'switch_payment_method' as const,
      expectedVersion: 3,
      paymentMethodId: methodId,
      consentMandateId: mandateId,
      reason: 'Family authorized this saved payment method',
    };
    await expect(
      repo.perform(installmentId, randomUUID(), {
        ...action,
        consentMandateId: randomUUID(),
      }),
    ).rejects.toThrow('payer mandate');
    const result = await repo.perform(installmentId, randomUUID(), action);
    expect(result).toMatchObject({
      version: 4,
      paymentMethodId: methodId,
      consentMandateId: mandateId,
    });
    const stored = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('installments')
        .select(['payment_method_id', 'autopay'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', installmentId)
        .executeTakeFirstOrThrow(),
    );
    expect(stored).toMatchObject({
      payment_method_id: methodId,
      autopay: true,
    });
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('autopay_authorizations')
        .set({ revoked_at: new Date() })
        .where('org_id', '=', context.orgId)
        .where('id', '=', mandateId)
        .execute(),
    );
    await expect(
      repo.perform(installmentId, randomUUID(), {
        ...action,
        expectedVersion: 4,
      }),
    ).rejects.toThrow('payer mandate');
  });

  it('waives the collectible installment with a balancing invoice discount', async () => {
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: payerAccountId,
      source: 'tuition',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'tuition',
          description: 'Second tuition',
          amountCents: 900,
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
          due_on: '2026-10-01',
          amount_cents: 900,
        })
        .execute(),
    );
    const pendingPaymentId = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('payments')
        .values({
          id: pendingPaymentId,
          org_id: context.orgId,
          account_id: payerAccountId,
          method: 'card',
          status: 'processing',
          amount_cents: 900,
        })
        .execute();
      await trx
        .insertInto('payment_allocations')
        .values({
          id: newId(),
          org_id: context.orgId,
          payment_id: pendingPaymentId,
          invoice_id: invoice.id,
          installment_id: targetId,
          amount_cents: 900,
        })
        .execute();
    });
    const repo = new PostgresInstallmentStaffActions(database, context, now);
    const key = randomUUID();
    const action = {
      action: 'waive' as const,
      expectedVersion: 1,
      reason: 'Approved hardship waiver',
    };
    await expect(repo.perform(targetId, key, action)).rejects.toThrow(
      'payment in progress',
    );
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('payments')
        .set({ status: 'canceled' })
        .where('org_id', '=', context.orgId)
        .where('id', '=', pendingPaymentId)
        .execute(),
    );
    const result = await repo.perform(targetId, key, action);
    expect(result).toMatchObject({ version: 2, waivedCents: 900 });
    expect(await repo.perform(targetId, key, action)).toEqual(result);
    const state = await createWithOrg(database)(context, async (trx) => ({
      invoice: await trx
        .selectFrom('invoices')
        .select(['total_cents', 'discount_cents', 'balance_cents', 'status'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', invoice.id)
        .executeTakeFirstOrThrow(),
      lines: await trx
        .selectFrom('invoice_lines')
        .select(['kind', 'amount_cents'])
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', invoice.id)
        .execute(),
      installment: await trx
        .selectFrom('installments')
        .select(['status', 'autopay'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', targetId)
        .executeTakeFirstOrThrow(),
    }));
    expect(state.invoice).toMatchObject({
      total_cents: 0,
      discount_cents: 900,
      balance_cents: 0,
      status: 'paid',
    });
    expect(state.lines.map((line) => line.amount_cents)).toEqual([900, -900]);
    expect(state.installment).toMatchObject({
      status: 'waived',
      autopay: false,
    });
    expect(await repo.listInvoice(invoice.id)).toMatchObject({
      installments: [{ id: targetId, status: 'waived', version: 2 }],
      consents: [],
    });
  });
});
