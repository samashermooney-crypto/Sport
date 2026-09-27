import { randomUUID } from 'node:crypto';

import {
  assertInvoiceLines,
  assertPaymentAllocations,
  deriveInvoiceState,
} from '@shared/algorithms/invoice-state';
import { newId } from '@shared/ids';
import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresCreditLedger } from './credits.js';
import {
  PostgresInvoiceRepository,
  recomputeInvoiceStatus,
} from './invoice-repo.js';
import { PostgresOfflinePayments } from './offline-payments.js';

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
      email: `reconciliation-${randomUUID()}@example.invalid`,
      first_name: 'Reconciliation',
      last_name: 'Property',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `reconciliation-${randomUUID().slice(0, 12)}`,
      name: 'Reconciliation Property',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
});
afterAll(async () => {
  await database.destroy();
});

async function assertReconciled(invoiceId: string): Promise<void> {
  await createWithOrg(database)(context, async (trx) => {
    const invoice = await trx
      .selectFrom('invoices')
      .select([
        'status',
        'total_cents',
        'paid_cents',
        'refunded_cents',
        'credit_applied_cents',
        'balance_cents',
      ])
      .where('org_id', '=', context.orgId)
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow();
    const lines = await trx
      .selectFrom('invoice_lines')
      .select('amount_cents')
      .where('org_id', '=', context.orgId)
      .where('invoice_id', '=', invoiceId)
      .execute();
    assertInvoiceLines(
      invoice.total_cents,
      lines.map((line) => ({ amountCents: line.amount_cents })),
    );
    const payments = await sql<{
      id: string;
      amount_cents: number;
      allocated_cents: number;
      refunded_cents: number;
    }>`
      SELECT p.id, p.amount_cents,
        coalesce(sum(pa.amount_cents), 0)::bigint AS allocated_cents,
        (SELECT coalesce(sum(r.amount_cents), 0)::bigint FROM refunds r
         WHERE r.org_id = p.org_id AND r.payment_id = p.id
           AND r.status = 'succeeded') AS refunded_cents
      FROM payments p JOIN payment_allocations pa
        ON pa.org_id = p.org_id AND pa.payment_id = p.id
      WHERE pa.org_id = ${context.orgId}::uuid
        AND pa.invoice_id = ${invoiceId}::uuid AND p.status = 'succeeded'
      GROUP BY p.id, p.amount_cents, p.org_id
    `.execute(trx);
    for (const payment of payments.rows)
      assertPaymentAllocations(
        payment.amount_cents,
        [payment.allocated_cents],
        [payment.refunded_cents],
      );
    const paid = payments.rows.reduce((sum, row) => sum + row.amount_cents, 0);
    const refunded = payments.rows.reduce(
      (sum, row) => sum + row.refunded_cents,
      0,
    );
    const credit = await sql<{ applied_cents: number }>`
      SELECT coalesce(-sum(amount_cents), 0)::bigint AS applied_cents
      FROM credits WHERE org_id = ${context.orgId}::uuid
        AND invoice_id = ${invoiceId}::uuid AND kind = 'applied'
    `.execute(trx);
    expect(invoice.paid_cents).toBe(paid);
    expect(invoice.refunded_cents).toBe(refunded);
    expect(invoice.credit_applied_cents).toBe(
      credit.rows[0]?.applied_cents ?? 0,
    );
    const expected = deriveInvoiceState({
      totalCents: invoice.total_cents,
      succeededAllocationsCents: paid,
      refundedToMethodCents: refunded,
      creditAppliedCents: invoice.credit_applied_cents,
      todayLocal: '2026-09-27',
      confirmed: true,
      voided: invoice.status === 'void',
    });
    expect(invoice.balance_cents).toBe(expected.balanceCents);
    expect(invoice.status).toBe(expected.status);
  });
}

describe('finance reconciliation property', () => {
  it('keeps invoice, payment, refund and credit ledgers reconciled through random sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          base: fc.integer({ min: 100, max: 10_000 }),
          discountPct: fc.integer({ min: 0, max: 70 }),
          creditPct: fc.integer({ min: 0, max: 60 }),
          firstPaymentPct: fc.integer({ min: 0, max: 100 }),
          secondPaymentPct: fc.integer({ min: 0, max: 100 }),
          refundPct: fc.integer({ min: 0, max: 100 }),
          attemptVoid: fc.boolean(),
        }),
        async (sample) => {
          const invoiceRepo = new PostgresInvoiceRepository(database, context);
          const ledger = new PostgresCreditLedger(database, context);
          const offline = new PostgresOfflinePayments(database, context);
          const discount = Math.floor((sample.base * sample.discountPct) / 100);
          const total = sample.base - discount;
          const bill = await invoiceRepo.issue({
            orgId: context.orgId,
            accountId: context.actor.accountId,
            source: 'staff',
            creationKey: randomUUID(),
            lines: [
              {
                kind: 'team_fee',
                description: 'Assessment',
                amountCents: sample.base,
                refundable: true,
              },
              ...(discount
                ? [
                    {
                      kind: 'discount' as const,
                      description: 'Discount',
                      amountCents: -discount,
                      parentLineIndex: 0,
                      refundable: false,
                    },
                  ]
                : []),
            ],
          });
          await assertReconciled(bill.id);
          const credit = Math.floor((total * sample.creditPct) / 100);
          if (credit > 0) {
            await ledger.issue({
              orgId: context.orgId,
              accountId: context.actor.accountId,
              amountCents: credit,
              source: 'property-fixture',
              operationKey: randomUUID(),
            });
            await ledger.apply({
              orgId: context.orgId,
              accountId: context.actor.accountId,
              invoiceId: bill.id,
              amountCents: credit,
              todayLocal: '2026-09-27',
              operationKey: randomUUID(),
            });
            await assertReconciled(bill.id);
          }
          const payable = total - credit;
          const first = Math.floor((payable * sample.firstPaymentPct) / 100);
          const second = Math.floor(
            ((payable - first) * sample.secondPaymentPct) / 100,
          );
          let firstPaymentId: string | null = null;
          for (const [index, amount] of [first, second].entries()) {
            if (!amount) continue;
            const receipt = await offline.record({
              orgId: context.orgId,
              invoiceId: bill.id,
              method: 'cash',
              amountCents: amount,
              reference: null,
              idempotencyKey: randomUUID(),
            });
            if (index === 0) firstPaymentId = receipt.paymentId;
            await assertReconciled(bill.id);
          }
          const refund = Math.floor((first * sample.refundPct) / 100);
          if (refund > 0 && firstPaymentId) {
            await createWithOrg(database)(context, async (trx) => {
              const line = await trx
                .selectFrom('invoice_lines')
                .select('id')
                .where('org_id', '=', context.orgId)
                .where('invoice_id', '=', bill.id)
                .where('kind', '=', 'team_fee')
                .executeTakeFirstOrThrow();
              const refundId = newId();
              await trx
                .insertInto('refunds')
                .values({
                  id: refundId,
                  org_id: context.orgId,
                  payment_id: firstPaymentId,
                  amount_cents: refund,
                  reason: 'duplicate',
                  status: 'succeeded',
                })
                .execute();
              await trx
                .insertInto('refund_allocations')
                .values({
                  id: newId(),
                  org_id: context.orgId,
                  refund_id: refundId,
                  invoice_line_id: line.id,
                  amount_cents: refund,
                })
                .execute();
              await trx
                .updateTable('invoices')
                .set({ refunded_cents: sql`refunded_cents + ${refund}` })
                .where('org_id', '=', context.orgId)
                .where('id', '=', bill.id)
                .execute();
              await recomputeInvoiceStatus(
                trx,
                context.orgId,
                bill.id,
                '2026-09-27',
              );
            });
            await assertReconciled(bill.id);
          }
          if (sample.attemptVoid) {
            const mayVoid = credit === 0 && first + second === refund;
            const operation = invoiceRepo.void({
              orgId: context.orgId,
              invoiceId: bill.id,
              reason: 'Property fixture',
            });
            if (mayVoid) await operation;
            else await expect(operation).rejects.toThrow();
            await assertReconciled(bill.id);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
