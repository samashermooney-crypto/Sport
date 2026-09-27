import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';

import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresSavedPaymentMethodRepository } from './payment-method-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let methods: PostgresSavedPaymentMethodRepository;
let methodRowId: string;
const stripeId = `pm_${randomUUID()}`;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  methods = new PostgresSavedPaymentMethodRepository(database);
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `saved-method-${randomUUID()}@example.invalid`,
      first_name: 'Saved',
      last_name: 'Method',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `saved-method-${randomUUID().slice(0, 12)}`,
      name: 'Saved Method Test Organization',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
});

afterAll(async () => {
  await database.destroy();
});

describe('saved payment method persistence', () => {
  it('syncs and defaults only the owning account method', async () => {
    const method = {
      id: stripeId,
      type: 'card' as const,
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      bankName: null,
    };
    await methods.sync(context.actor.accountId, [method]);
    await methods.sync(context.actor.accountId, [method]);
    await methods.setDefault(context.actor.accountId, stripeId);
    const rows = await database
      .selectFrom('payment_methods')
      .select(['id', 'status', 'is_default'])
      .where('account_id', '=', context.actor.accountId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'active', is_default: true });
    const stored = rows[0];
    if (!stored) throw new Error('Saved method was not stored');
    methodRowId = stored.id;
    await expect(methods.sync(newId(), [method])).rejects.toThrow(
      'different payer',
    );
  });

  it('detaches the method and disables org-scoped autopay without deleting evidence', async () => {
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
          kind: 'tuition',
          description: 'Tuition',
          amountCents: 1000,
          refundable: true,
        },
      ],
    });
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('installments')
        .values({
          id: newId(),
          org_id: context.orgId,
          invoice_id: invoice.id,
          sequence: 1,
          due_on: '2026-10-01',
          amount_cents: 1000,
          autopay: true,
          payment_method_id: methodRowId,
        })
        .execute();
      await trx
        .insertInto('autopay_authorizations')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: context.actor.accountId,
          payment_method_id: methodRowId,
          invoice_id: invoice.id,
          mandate_text_version: 'test-v1',
        })
        .execute();
    });
    await methods.markDetached(context.actor.accountId, stripeId);
    await methods.markDetached(context.actor.accountId, stripeId);
    const state = await createWithOrg(database)(context, async (trx) => ({
      installment: await trx
        .selectFrom('installments')
        .select(['autopay', 'payment_method_id'])
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', invoice.id)
        .executeTakeFirstOrThrow(),
      authorization: await trx
        .selectFrom('autopay_authorizations')
        .select('revoked_at')
        .where('org_id', '=', context.orgId)
        .where('invoice_id', '=', invoice.id)
        .executeTakeFirstOrThrow(),
    }));
    expect(state.installment).toEqual({
      autopay: false,
      payment_method_id: null,
    });
    expect(state.authorization.revoked_at).toBeTruthy();
    const method = await database
      .selectFrom('payment_methods')
      .select(['status', 'is_default'])
      .where('id', '=', methodRowId)
      .executeTakeFirstOrThrow();
    expect(method).toEqual({ status: 'detached', is_default: false });
  });
});
