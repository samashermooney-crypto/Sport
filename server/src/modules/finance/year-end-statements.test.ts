import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import {
  PostgresInvoiceRepository,
  recomputeInvoiceStatus,
} from './invoice-repo.js';
import { PostgresOfflinePayments } from './offline-payments.js';
import { PostgresYearEndStatements } from './year-end-statements.js';

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
      email: `statement-${randomUUID()}@example.invalid`,
      first_name: 'Statement',
      last_name: 'Payer',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `statement-${randomUUID().slice(0, 12)}`,
      name: 'Statement Club',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
});
afterAll(async () => {
  await database.destroy();
});

describe('payer year-end statement', () => {
  it('uses org-local year boundaries and separates donation refund cash flow', async () => {
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'donation',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'donation',
          description: 'Club gift',
          amountCents: 1000,
          refundable: true,
        },
      ],
    });
    const receipt = await new PostgresOfflinePayments(database, context).record(
      {
        orgId: context.orgId,
        invoiceId: invoice.id,
        amountCents: 1000,
        method: 'cash',
        reference: null,
        idempotencyKey: randomUUID(),
      },
    );
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('payments')
        .set({ succeeded_at: new Date('2027-01-01T00:30:00Z') })
        .where('org_id', '=', context.orgId)
        .where('id', '=', receipt.paymentId)
        .execute(),
    );
    const statements = new PostgresYearEndStatements(database, context);
    expect(await statements.read(2026)).toMatchObject({
      year: 2026,
      paymentCount: 1,
      totalPaidCents: 1000,
      donationPaidCents: 1000,
      donationRefundedCents: 0,
    });
    const line = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('invoice_lines')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', invoice.id)
        .executeTakeFirstOrThrow(),
    );
    await createWithOrg(database)(context, async (trx) => {
      const refundId = newId();
      await sql`
        INSERT INTO refunds (id, org_id, payment_id, amount_cents,
          reason, status, destination, succeeded_at)
        VALUES (${refundId}::uuid, ${context.orgId}::uuid,
          ${receipt.paymentId}::uuid, 100, 'other', 'succeeded',
          'original_method', '2027-01-01T07:00:00Z'::timestamptz)
      `.execute(trx);
      await trx
        .insertInto('refund_allocations')
        .values({
          id: newId(),
          org_id: context.orgId,
          refund_id: refundId,
          invoice_line_id: line.id,
          amount_cents: 100,
        })
        .execute();
      await trx
        .updateTable('invoices')
        .set({
          refunded_cents: sql`refunded_cents + 100`,
          version: sql`version + 1`,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', invoice.id)
        .execute();
      await recomputeInvoiceStatus(
        trx,
        context.orgId,
        invoice.id,
        '2027-01-01',
      );
    });
    expect(await statements.read(2027)).toMatchObject({
      year: 2027,
      paymentCount: 0,
      totalPaidCents: 0,
      refundedToOriginalCents: 100,
      donationPaidCents: 0,
      donationRefundedCents: 100,
    });
    await createWithOrg(database)(context, async (trx) => {
      const refundId = newId();
      await trx
        .insertInto('refunds')
        .values({
          id: refundId,
          org_id: context.orgId,
          payment_id: receipt.paymentId,
          amount_cents: 100,
          reason: 'other',
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
          amount_cents: 100,
        })
        .execute();
      await trx
        .updateTable('invoices')
        .set({
          refunded_cents: sql`refunded_cents + 100`,
          version: sql`version + 1`,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', invoice.id)
        .execute();
      await recomputeInvoiceStatus(
        trx,
        context.orgId,
        invoice.id,
        '2027-01-01',
      );
    });
    await expect(statements.read(2027)).rejects.toThrow(
      'lacks a settlement date',
    );
  });
});
