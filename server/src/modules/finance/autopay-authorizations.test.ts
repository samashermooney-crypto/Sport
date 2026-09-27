import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresAutopayAuthorizations } from './autopay-authorizations.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let other: OrgContext;
let mandateId: string;
let invoiceId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const otherAccountId = newId();
  const orgId = newId();
  for (const id of [accountId, otherAccountId]) {
    await database
      .insertInto('accounts')
      .values({
        id,
        email: `autopay-${randomUUID()}@example.invalid`,
        first_name: 'Payer',
        last_name: 'Test',
        date_of_birth: '1990-01-01',
      })
      .execute();
  }
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `autopay-${randomUUID().slice(0, 12)}`,
      name: 'Autopay Club',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  other = { orgId, actor: { accountId: otherAccountId } };
  const invoice = await new PostgresInvoiceRepository(database, context).issue({
    orgId,
    accountId,
    source: 'staff',
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
  const methodId = newId();
  mandateId = newId();
  await database
    .insertInto('payment_methods')
    .values({
      id: methodId,
      account_id: accountId,
      stripe_payment_method_id: `pm_${randomUUID()}`,
      type: 'card',
      last4: '4242',
    })
    .execute();
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('installments')
      .values({
        id: newId(),
        org_id: orgId,
        invoice_id: invoiceId,
        sequence: 1,
        due_on: '2026-10-01',
        amount_cents: 1000,
        autopay: true,
        payment_method_id: methodId,
      })
      .execute();
    await trx
      .insertInto('autopay_authorizations')
      .values({
        id: mandateId,
        org_id: orgId,
        account_id: accountId,
        payment_method_id: methodId,
        invoice_id: invoiceId,
        mandate_text_version: 'mandate-v1',
      })
      .execute();
  });
});
afterAll(async () => {
  await database.destroy();
});

describe('payer autopay authorizations', () => {
  it('shows only the payer mandate and revokes future charges once', async () => {
    const payer = new PostgresAutopayAuthorizations(database, context);
    const outsider = new PostgresAutopayAuthorizations(database, other);
    expect(await outsider.staffMethodOptions()).toEqual({ invoices: [] });
    expect(await payer.staffMethodOptions()).toMatchObject({
      invoices: [{ id: invoiceId, futureInstallments: 1 }],
    });
    expect(await outsider.list()).toEqual([]);
    await expect(outsider.revoke(mandateId)).rejects.toThrow();
    expect(await payer.list()).toMatchObject([
      {
        id: mandateId,
        invoiceId,
        last4: '4242',
        futureInstallments: 1,
        revokedAt: null,
      },
    ]);
    expect(await payer.revoke(mandateId)).toEqual({
      revoked: true,
      stoppedInstallments: 1,
    });
    expect(await payer.revoke(mandateId)).toEqual({
      revoked: false,
      stoppedInstallments: 0,
    });
    const after = await payer.list();
    expect(after).toMatchObject([{ id: mandateId, futureInstallments: 0 }]);
    expect(typeof after[0]?.revokedAt).toBe('string');
    const installment = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('installments')
        .select(['autopay', 'payment_method_id', 'next_attempt_at'])
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', invoiceId)
        .executeTakeFirstOrThrow(),
    );
    expect(installment).toMatchObject({
      autopay: false,
      payment_method_id: null,
      next_attempt_at: null,
    });
  });

  it('records exact-invoice saved-method consent with a replay key', async () => {
    const stripePaymentMethodId = `pm_${randomUUID().replaceAll('-', '')}`;
    await database
      .insertInto('payment_methods')
      .values({
        id: newId(),
        account_id: context.actor.accountId,
        stripe_payment_method_id: stripePaymentMethodId,
        type: 'card',
        status: 'active',
      })
      .execute();
    const payer = new PostgresAutopayAuthorizations(database, context);
    const outsider = new PostgresAutopayAuthorizations(database, other);
    const input = {
      invoiceId,
      stripePaymentMethodId,
      operationKey: randomUUID(),
      accepted: true as const,
      ip: '127.0.0.1/32',
      userAgent: 'test-agent',
    };
    await expect(outsider.authorizeStaffMethod(input)).rejects.toThrow(
      'Invoice is not payable',
    );
    const captured = await payer.authorizeStaffMethod(input);
    expect(await payer.authorizeStaffMethod(input)).toEqual(captured);
    await expect(
      payer.authorizeStaffMethod({
        ...input,
        stripePaymentMethodId: `pm_${randomUUID().replaceAll('-', '')}`,
      }),
    ).rejects.toThrow('key was reused');
    const stored = await createWithOrg(database)(context, async (trx) => {
      const rows = await sql<{
        account_id: string;
        invoice_id: string;
        mandate_text_version: string;
        mandate_text_hash: string;
        ip: string;
        user_agent: string;
      }>`
        SELECT account_id, invoice_id, mandate_text_version,
          mandate_text_hash, ip::text, user_agent
        FROM autopay_authorizations WHERE org_id = ${context.orgId}::uuid
          AND id = ${captured.id}::uuid
      `.execute(trx);
      return rows.rows[0] ?? null;
    });
    expect(stored).toMatchObject({
      account_id: context.actor.accountId,
      invoice_id: invoiceId,
      mandate_text_version: 'staff-method-consent-v1',
      ip: '127.0.0.1/32',
      user_agent: 'test-agent',
    });
    expect(stored?.mandate_text_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
