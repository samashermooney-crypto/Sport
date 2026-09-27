import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresCreditRefundRepository } from './credit-refund-repo.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';
import { allocatePaymentLines } from './payment-line-allocations.js';
import { PostgresRefundRecordStore } from './refund-record-repo.js';
import { PostgresRefundSourceReader } from './refund-source-repo.js';
import { refundProposal } from './refunds.js';

let database: Kysely<DB>;
let context: OrgContext;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `payment-lines-${randomUUID()}@example.invalid`,
      first_name: 'Payment',
      last_name: 'Lines',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `payment-lines-${randomUUID().slice(0, 8)}`,
      name: 'Payment Lines',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
});

afterAll(async () => {
  await database.destroy();
});

describe('immutable payment line allocations', () => {
  it('funds net lines exactly across partial payments and frees a failed attempt', async () => {
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'staff',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'registration',
          description: 'Program A',
          amountCents: 700,
          refundable: true,
        },
        {
          kind: 'registration',
          description: 'Program B',
          amountCents: 300,
          refundable: true,
        },
        {
          kind: 'discount',
          description: 'Aid',
          amountCents: -100,
          refundable: false,
          parentLineIndex: 0,
        },
        {
          kind: 'service_fee',
          description: 'Service fee',
          amountCents: 50,
          refundable: true,
        },
      ],
      refundTerms: {
        policy: {
          rules: [],
          afterLastBps: 10_000,
          serviceFeeRefund: 'proportional',
        },
        approvalThresholdCents: 500,
        refundApplicationFee: true,
      },
    });
    expect(invoice.totalCents).toBe(950);
    const record = async (amountCents: number) => {
      const paymentId = newId();
      await createWithOrg(database)(context, async (trx) => {
        await trx
          .insertInto('payments')
          .values({
            id: paymentId,
            org_id: context.orgId,
            account_id: context.actor.accountId,
            method: 'card',
            status: 'requires_action',
            amount_cents: amountCents,
            stripe_payment_intent_id: `pi_${randomUUID()}`,
          })
          .execute();
        await trx
          .insertInto('payment_allocations')
          .values({
            id: newId(),
            org_id: context.orgId,
            payment_id: paymentId,
            invoice_id: invoice.id,
            amount_cents: amountCents,
          })
          .execute();
        await allocatePaymentLines(trx, {
          orgId: context.orgId,
          invoiceId: invoice.id,
          paymentId,
          amountCents,
        });
      });
      return paymentId;
    };
    const first = await record(400);
    const second = await record(550);
    const allocated = await createWithOrg(database)(context, (trx) =>
      sql<{
        payment_id: string;
        invoice_line_id: string;
        amount_cents: number;
      }>`
        SELECT payment_id, invoice_line_id, amount_cents
        FROM payment_line_allocations WHERE org_id = ${context.orgId}::uuid
          AND invoice_id = ${invoice.id}::uuid
      `.execute(trx),
    );
    expect(
      allocated.rows
        .filter((row) => row.payment_id === first)
        .reduce((sum, row) => sum + row.amount_cents, 0),
    ).toBe(400);
    expect(
      allocated.rows
        .filter((row) => row.payment_id === second)
        .reduce((sum, row) => sum + row.amount_cents, 0),
    ).toBe(550);
    const byLine = new Map<string, number>();
    for (const row of allocated.rows)
      byLine.set(
        row.invoice_line_id,
        (byLine.get(row.invoice_line_id) ?? 0) + row.amount_cents,
      );
    expect([...byLine.values()].sort((a, b) => a - b)).toEqual([50, 300, 600]);
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('payments')
        .set({ status: 'failed' })
        .where('org_id', '=', context.orgId)
        .where('id', '=', first)
        .execute(),
    );
    const replacement = await record(400);
    const replacementRows = await createWithOrg(database)(context, (trx) =>
      sql<{ amount_cents: number }>`
        SELECT amount_cents FROM payment_line_allocations
        WHERE org_id = ${context.orgId}::uuid
          AND payment_id = ${replacement}::uuid
      `.execute(trx),
    );
    expect(
      replacementRows.rows.reduce((sum, row) => sum + row.amount_cents, 0),
    ).toBe(400);
    await createWithOrg(database)(context, (trx) =>
      allocatePaymentLines(trx, {
        orgId: context.orgId,
        invoiceId: invoice.id,
        paymentId: replacement,
        amountCents: 400,
      }),
    );
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .updateTable('payments')
        .set({ status: 'succeeded', succeeded_at: new Date() })
        .where('org_id', '=', context.orgId)
        .where('id', 'in', [second, replacement])
        .execute();
      await trx
        .updateTable('invoices')
        .set({ paid_cents: 950, status: 'paid' })
        .where('org_id', '=', context.orgId)
        .where('id', '=', invoice.id)
        .execute();
    });
    const reader = new PostgresRefundSourceReader(database, context);
    const secondSource = await reader.load(context.orgId, second);
    const replacementSource = await reader.load(context.orgId, replacement);
    if (!secondSource || !replacementSource)
      throw new Error('Expected both payment refund sources');
    const funded = (source: NonNullable<typeof secondSource>) =>
      source.lines.reduce((sum, line) => sum + line.paidCents, 0) +
      source.paidServiceFeeCents;
    expect(funded(secondSource)).toBe(550);
    expect(funded(replacementSource)).toBe(400);
    expect(secondSource.lines.map((line) => line.id)).toEqual(
      replacementSource.lines.map((line) => line.id),
    );
    const refundRecords = new PostgresRefundRecordStore(database, context);
    const firstLine = secondSource.lines[0];
    if (!firstLine) throw new Error('Expected funded registration line');
    await expect(
      refundRecords.recordPending({
        orgId: context.orgId,
        paymentId: second,
        refundId: `re_${randomUUID()}`,
        requestedByAccountId: context.actor.accountId,
        approvedByAccountId: null,
        refundApplicationFee: true,
        proposal: {
          lines: [{ lineId: firstLine.id, amountCents: 550 }],
          serviceFeeCents: 0,
          totalCents: 550,
          refundBps: 10_000,
        },
      }),
    ).rejects.toThrow('funded by this payment');
    const validProposal = refundProposal(secondSource, '2026-09-27');
    await refundRecords.recordPending({
      orgId: context.orgId,
      paymentId: second,
      refundId: `re_${randomUUID()}`,
      requestedByAccountId: context.actor.accountId,
      approvedByAccountId: null,
      refundApplicationFee: true,
      proposal: validProposal,
    });
    const credits = new PostgresCreditRefundRepository(database, context);
    const creditRequest = {
      orgId: context.orgId,
      paymentId: replacement,
      cancellationDate: '2026-09-27',
      requestedByAccountId: context.actor.accountId,
      idempotencyKey: randomUUID(),
      recipient: 'account' as const,
    };
    const secondLine = replacementSource.lines[1];
    if (!secondLine)
      throw new Error('Expected second funded registration line');
    await expect(
      credits.apply(creditRequest, 'a'.repeat(64), {
        lines: [
          { lineId: firstLine.id, amountCents: 300 },
          { lineId: secondLine.id, amountCents: 100 },
        ],
        serviceFeeCents: 0,
        totalCents: 400,
        refundBps: 10_000,
      }),
    ).rejects.toThrow('proposal changed before application');
    const credit = await credits.apply(
      { ...creditRequest, idempotencyKey: randomUUID() },
      'b'.repeat(64),
      refundProposal(replacementSource, '2026-09-27'),
    );
    expect(credit.amountCents).toBe(400);
  });

  it('serializes competing partial payments before any line can be overfunded', async () => {
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'staff',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'registration',
          description: 'First',
          amountCents: 60,
          refundable: true,
        },
        {
          kind: 'registration',
          description: 'Second',
          amountCents: 40,
          refundable: true,
        },
      ],
    });
    const attempt = () =>
      createWithOrg(database)(context, async (trx) => {
        const paymentId = newId();
        await trx
          .insertInto('payments')
          .values({
            id: paymentId,
            org_id: context.orgId,
            account_id: context.actor.accountId,
            method: 'card',
            status: 'requires_action',
            amount_cents: 70,
            stripe_payment_intent_id: `pi_${randomUUID()}`,
          })
          .execute();
        await trx
          .insertInto('payment_allocations')
          .values({
            id: newId(),
            org_id: context.orgId,
            payment_id: paymentId,
            invoice_id: invoice.id,
            amount_cents: 70,
          })
          .execute();
        await allocatePaymentLines(trx, {
          orgId: context.orgId,
          invoiceId: invoice.id,
          paymentId,
          amountCents: 70,
        });
        return paymentId;
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const funded = await createWithOrg(database)(context, (trx) =>
      sql<{ total: number }>`
        SELECT coalesce(sum(amount_cents), 0)::bigint AS total
        FROM payment_line_allocations
        WHERE org_id = ${context.orgId}::uuid AND invoice_id = ${invoice.id}::uuid
      `.execute(trx),
    );
    expect(funded.rows[0]?.total).toBe(70);
  });
});
