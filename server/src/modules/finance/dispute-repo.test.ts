import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { GatewayDispute } from '../../integrations/stripe/gateway.js';

import { PostgresDisputeRepository } from './dispute-repo.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresPaymentEventRepository } from './payment-event-repo.js';
import { PostgresPaymentRecordStore } from './payment-repo.js';

let database: Kysely<DB>;
let context: OrgContext;
let invoiceId: string;
let dispute: GatewayDispute;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  const checkoutId = newId();
  const paymentIntentId = `pi_${randomUUID()}`;
  const chargeId = `ch_${randomUUID()}`;
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `dispute-${randomUUID()}@example.invalid`,
      first_name: 'Dispute',
      last_name: 'Actor',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `dispute-${randomUUID().slice(0, 12)}`,
      name: 'Dispute Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  const invoice = await new PostgresInvoiceRepository(database, context).issue({
    orgId,
    accountId,
    source: 'checkout',
    creationKey: randomUUID(),
    lines: [
      {
        kind: 'registration',
        description: 'Registration',
        amountCents: 1000,
        refundable: true,
      },
    ],
  });
  invoiceId = invoice.id;
  await createWithOrg(database)(context, (trx) =>
    trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        org_id: orgId,
        account_id: accountId,
        status: 'awaiting_payment',
        expires_at: new Date('2027-01-01T00:00:00Z'),
        pricing_snapshot: { totalCents: 1000 },
      })
      .execute(),
  );
  await new PostgresPaymentRecordStore(database, context).recordPending({
    orgId,
    checkoutId,
    invoiceId,
    accountId,
    paymentIntentId,
    amountCents: 1000,
    applicationFeeCents: 10,
    idempotencyKey: randomUUID(),
  });
  await new PostgresPaymentEventRepository(database, accountId, () =>
    Temporal.Instant.from('2026-09-26T12:00:00Z'),
  ).applyLatest({
    orgId,
    paymentIntentId,
    latest: {
      id: paymentIntentId,
      clientSecret: null,
      status: 'succeeded',
      amountCents: 1000,
      latestChargeId: chargeId,
      method: 'card',
    },
  });
  dispute = {
    id: `dp_${randomUUID()}`,
    chargeId,
    paymentIntentId,
    transferId: `tr_${randomUUID()}`,
    amountCents: 400,
    feeCents: 1500,
    status: 'needs_response',
    reason: 'general',
    evidenceDueBy: 1_700_000_000,
    fundsWithdrawn: true,
    fundsReinstated: false,
  };
});

afterAll(async () => {
  await database.destroy();
});

describe('dispute invoice accounting', () => {
  it('holds disputed cents, then reopens the balance on loss exactly once', async () => {
    const repo = new PostgresDisputeRepository(
      database,
      context.actor.accountId,
    );
    expect(await repo.applyLatest(context.orgId, dispute)).toBe('applied');
    expect(await repo.applyLatest(context.orgId, dispute)).toBe('unchanged');
    let invoice = await createWithOrg(database)(
      context,
      async (trx) =>
        (
          await sql<{
            disputed_cents: number;
            dispute_lost_cents: number;
            balance_cents: number;
          }>`
        SELECT disputed_cents, dispute_lost_cents, balance_cents FROM invoices
        WHERE org_id = ${context.orgId}::uuid AND id = ${invoiceId}::uuid
      `.execute(trx)
        ).rows[0],
    );
    expect(invoice).toMatchObject({
      disputed_cents: 400,
      dispute_lost_cents: 0,
      balance_cents: 0,
    });
    expect(
      await repo.applyLatest(context.orgId, { ...dispute, status: 'lost' }),
    ).toBe('applied');
    expect(
      await repo.applyLatest(context.orgId, { ...dispute, status: 'lost' }),
    ).toBe('unchanged');
    invoice = await createWithOrg(database)(
      context,
      async (trx) =>
        (
          await sql<{
            disputed_cents: number;
            dispute_lost_cents: number;
            balance_cents: number;
          }>`
        SELECT disputed_cents, dispute_lost_cents, balance_cents FROM invoices
        WHERE org_id = ${context.orgId}::uuid AND id = ${invoiceId}::uuid
      `.execute(trx)
        ).rows[0],
    );
    expect(invoice).toMatchObject({
      disputed_cents: 0,
      dispute_lost_cents: 400,
      balance_cents: 400,
    });
    await expect(
      repo.applyLatest(context.orgId, { ...dispute, status: 'won' }),
    ).rejects.toThrow('cannot regress');
  });
});
