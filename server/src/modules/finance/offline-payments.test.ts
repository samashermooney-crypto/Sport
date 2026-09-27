import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { bindFixtureInvoice } from '../checkout/test-fixtures.js';

import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresOfflinePayments } from './offline-payments.js';
import { PostgresPaymentRecordStore } from './payment-repo.js';
import { FinanceAccessError, requireFinanceStaff } from './staff-access.js';

let database: Kysely<DB>;
let context: OrgContext;
let invoiceId: string;
let roleId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `offline-${randomUUID()}@example.invalid`,
      first_name: 'Offline',
      last_name: 'Actor',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `offline-${randomUUID().slice(0, 12)}`,
      name: 'Offline Payments Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  roleId = newId();
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        status: 'active',
        joined_at: new Date(),
      })
      .execute();
    await trx
      .insertInto('role_assignments')
      .values({
        id: roleId,
        org_id: orgId,
        account_id: accountId,
        role: 'finance',
        scope_type: 'org',
        pending_mfa: false,
      })
      .execute();
  });
  invoiceId = (
    await new PostgresInvoiceRepository(database, context).issue({
      orgId,
      accountId,
      source: 'staff',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'registration',
          description: 'Registration',
          amountCents: 1000,
          refundable: true,
        },
      ],
    })
  ).id;
});

afterAll(async () => {
  await database.destroy();
});

describe('offline payments', () => {
  it('requires active finance access with completed MFA', async () => {
    await expect(
      requireFinanceStaff(database, context),
    ).resolves.toBeUndefined();
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('role_assignments')
        .set({ pending_mfa: true })
        .where('org_id', '=', context.orgId)
        .where('id', '=', roleId)
        .execute(),
    );
    await expect(requireFinanceStaff(database, context)).rejects.toBeInstanceOf(
      FinanceAccessError,
    );
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', context.orgId)
        .where('id', '=', roleId)
        .execute(),
    );
  });
  it('allocates a receipt, replays the exact request, and prevents concurrent overpayment', async () => {
    const repo = new PostgresOfflinePayments(database, context);
    const input = {
      orgId: context.orgId,
      invoiceId,
      method: 'check' as const,
      amountCents: 400,
      reference: '  1234  ',
      idempotencyKey: randomUUID(),
    };
    const first = await repo.record(input);
    expect(first).toMatchObject({ amountCents: 400, receiptNumber: 1 });
    expect(await repo.record(input)).toEqual(first);
    await expect(repo.record({ ...input, amountCents: 401 })).rejects.toThrow(
      'conflicts',
    );
    const results = await Promise.allSettled([
      repo.record({
        ...input,
        method: 'cash',
        reference: null,
        amountCents: 400,
        idempotencyKey: randomUUID(),
      }),
      repo.record({
        ...input,
        method: 'cash',
        reference: null,
        amountCents: 400,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const checkoutId = newId();
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('checkouts')
        .values({
          id: checkoutId,
          org_id: context.orgId,
          account_id: context.actor.accountId,
          status: 'awaiting_payment',
          expires_at: new Date('2027-01-01T00:00:00Z'),
          pricing_snapshot: { totalCents: 150 },
        })
        .execute(),
    );
    await bindFixtureInvoice(database, context, checkoutId, invoiceId);
    await new PostgresPaymentRecordStore(database, context).recordPending({
      orgId: context.orgId,
      checkoutId,
      invoiceId,
      accountId: context.actor.accountId,
      paymentIntentId: `pi_${randomUUID()}`,
      amountCents: 150,
      applicationFeeCents: 1,
      idempotencyKey: randomUUID(),
    });
    await expect(
      repo.record({
        ...input,
        method: 'cash',
        reference: null,
        amountCents: 100,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('available invoice balance');
    await expect(
      repo.record({
        ...input,
        method: 'external',
        reference: null,
        amountCents: 100,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('require a reference');
  });
});
