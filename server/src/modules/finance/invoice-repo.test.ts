import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import {
  PostgresInvoiceRepository,
  recomputeInvoiceStatus,
} from './invoice-repo.js';
import { invoiceTotals, type IssueInvoiceInput } from './invoices.js';

let database: Kysely<DB>;
let context: OrgContext;
let repository: PostgresInvoiceRepository;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `invoice-${randomUUID()}@example.invalid`,
      first_name: 'Invoice',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `invoice-${randomUUID().slice(0, 12)}`,
      name: 'Invoice Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  repository = new PostgresInvoiceRepository(database, context);
});

afterAll(async () => {
  await database.destroy();
});

function input(key = randomUUID()): IssueInvoiceInput {
  return {
    orgId: context.orgId,
    accountId: context.actor.accountId,
    source: 'order',
    creationKey: key,
    lines: [
      {
        kind: 'product',
        description: 'Uniform',
        amountCents: 1000,
        refundable: true,
      },
      {
        kind: 'discount',
        description: 'Promo',
        amountCents: -100,
        refundable: false,
        parentLineIndex: 0,
      },
      {
        kind: 'tax',
        description: 'Sales tax',
        amountCents: 45,
        refundable: true,
        taxRateBps: 500,
      },
    ],
  };
}

describe('invoice issuance', () => {
  it('accepts only exact discounted-product tax on an order', () => {
    const order = input();
    expect(invoiceTotals(order).taxCents).toBe(45);
    expect(() =>
      invoiceTotals({
        ...order,
        lines: order.lines.map((line) =>
          line.kind === 'tax' ? { ...line, amountCents: 50 } : line,
        ),
      }),
    ).toThrow('does not match');
    expect(() =>
      invoiceTotals({
        ...order,
        lines: [
          {
            kind: 'registration',
            description: 'Registration',
            amountCents: 1000,
            refundable: true,
          },
          {
            kind: 'tax',
            description: 'Sales tax',
            amountCents: 50,
            refundable: true,
            taxRateBps: 500,
          },
        ],
      }),
    ).toThrow('requires a positive rate and product');
  });
  it('assigns one number and reconciles header and lines at commit', async () => {
    const request = input();
    expect(invoiceTotals(request)).toEqual({
      subtotalCents: 1000,
      discountCents: 100,
      serviceFeeCents: 0,
      taxCents: 45,
      totalCents: 945,
    });
    const [first, replay] = await Promise.all([
      repository.issue(request),
      repository.issue(request),
    ]);
    expect(first).toEqual(replay);
    expect(first.number).toBe(1);
    const header = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('invoices')
        .select(['number', 'total_cents', 'balance_cents', 'tax_cents'])
        .where('id', '=', first.id)
        .executeTakeFirstOrThrow(),
    );
    expect(header).toEqual({
      number: 1,
      total_cents: 945,
      balance_cents: 945,
      tax_cents: 45,
    });
    const parentLinks = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('invoice_lines')
        .select(['id', 'kind', 'parent_line_id'])
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', first.id)
        .execute(),
    );
    expect(
      parentLinks.find((line) => line.kind === 'discount')?.parent_line_id,
    ).toBe(parentLinks.find((line) => line.kind === 'product')?.id);
    const second = await repository.issue(input());
    expect(second.number).toBe(2);
  });

  it('rejects a changed request under one key and tax outside an order', async () => {
    const request = input();
    await repository.issue(request);
    await expect(
      repository.issue({
        ...request,
        lines: [
          {
            kind: 'product',
            description: 'Uniform',
            amountCents: 900,
            refundable: true,
          },
        ],
      }),
    ).rejects.toThrow('different request');
    expect(() => invoiceTotals({ ...input(), source: 'staff' })).toThrow(
      'only to product orders',
    );
  });

  it('derives past-due status without changing the idempotent issuance result', async () => {
    const request = { ...input(), dueOn: '2026-01-01' };
    const issued = await repository.issue(request);
    const status = await createWithOrg(database)(context, (trx) =>
      recomputeInvoiceStatus(trx, context.orgId, issued.id, '2026-09-26'),
    );
    expect(status).toBe('past_due');
    expect(await repository.issue(request)).toEqual(issued);
  });

  it('voids only after successful payment is fully refunded and audits the action', async () => {
    const invoice = await repository.issue(input());
    const paymentId = newId();
    const refundId = newId();
    const lineId = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('invoice_lines')
        .select('id')
        .where('invoice_id', '=', invoice.id)
        .where('kind', '=', 'product')
        .executeTakeFirstOrThrow(),
    );
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('payments')
        .values({
          id: paymentId,
          org_id: context.orgId,
          account_id: context.actor.accountId,
          method: 'card',
          status: 'succeeded',
          amount_cents: 945,
        })
        .execute();
      await trx
        .insertInto('payment_allocations')
        .values({
          id: newId(),
          org_id: context.orgId,
          payment_id: paymentId,
          invoice_id: invoice.id,
          amount_cents: 945,
        })
        .execute();
      await trx
        .updateTable('invoices')
        .set({ paid_cents: 945 })
        .where('id', '=', invoice.id)
        .execute();
      expect(
        await recomputeInvoiceStatus(
          trx,
          context.orgId,
          invoice.id,
          '2026-09-26',
        ),
      ).toBe('paid');
    });
    await expect(
      repository.void({
        orgId: context.orgId,
        invoiceId: invoice.id,
        reason: 'Duplicate assessment',
      }),
    ).rejects.toThrow('Cannot void');
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('refunds')
        .values({
          id: refundId,
          org_id: context.orgId,
          payment_id: paymentId,
          amount_cents: 945,
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
          invoice_line_id: lineId.id,
          amount_cents: 945,
        })
        .execute();
      await trx
        .updateTable('invoices')
        .set({ refunded_cents: 945 })
        .where('id', '=', invoice.id)
        .execute();
      expect(
        await recomputeInvoiceStatus(
          trx,
          context.orgId,
          invoice.id,
          '2026-09-26',
        ),
      ).toBe('open');
    });
    const unsettledPaymentId = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('payments')
        .values({
          id: unsettledPaymentId,
          org_id: context.orgId,
          account_id: context.actor.accountId,
          method: 'card',
          status: 'processing',
          amount_cents: 100,
        })
        .execute();
      await trx
        .insertInto('payment_allocations')
        .values({
          id: newId(),
          org_id: context.orgId,
          payment_id: unsettledPaymentId,
          invoice_id: invoice.id,
          amount_cents: 100,
        })
        .execute();
    });
    await expect(
      repository.void({
        orgId: context.orgId,
        invoiceId: invoice.id,
        reason: 'Duplicate assessment',
      }),
    ).rejects.toThrow('unsettled payment');
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('payments')
        .set({ status: 'failed' })
        .where('org_id', '=', context.orgId)
        .where('id', '=', unsettledPaymentId)
        .execute(),
    );
    await repository.void({
      orgId: context.orgId,
      invoiceId: invoice.id,
      reason: 'Duplicate assessment',
    });
    const record = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('invoices')
        .select(['status', 'void_reason'])
        .where('id', '=', invoice.id)
        .executeTakeFirstOrThrow(),
    );
    expect(record).toEqual({
      status: 'void',
      void_reason: 'Duplicate assessment',
    });
    const events = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('audit_log')
        .select('action')
        .where('org_id', '=', context.orgId)
        .where('entity_id', '=', invoice.id)
        .execute(),
    );
    expect(events.map((event) => event.action).sort()).toEqual([
      'invoice.issued',
      'invoice.voided',
    ]);
  });
});
