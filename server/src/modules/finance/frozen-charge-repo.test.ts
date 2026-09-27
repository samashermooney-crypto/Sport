import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB, Json } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { PostgresCheckoutInvoiceLinker } from '../checkout/invoice-link-repo.js';

import { PostgresFrozenChargeReader } from './frozen-charge-repo.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresPayerProfileRepository } from './payer-repo.js';
import { quoteCharge } from './service.js';

let database: Kysely<DB>;
let context: OrgContext;
let checkoutId: string;
let invoiceId: string;
let snapshot: Record<string, unknown>;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  checkoutId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `frozen-charge-${randomUUID()}@example.invalid`,
      first_name: 'Frozen',
      last_name: 'Charge',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `frozen-charge-${randomUUID().slice(0, 12)}`,
      name: 'Frozen Charge',
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
      {
        kind: 'service_fee',
        description: 'Service fee',
        amountCents: 50,
        refundable: true,
      },
    ],
  });
  invoiceId = invoice.id;
  snapshot = {
    subtotalCents: 1000,
    discountCents: 0,
    aidCents: 0,
    creditAppliedCents: 0,
    serviceFeeCents: 50,
    taxCents: 0,
    invoiceTotalCents: 1050,
    chargeNowCents: 1050,
    paymentTerms: {
      applicationRate: { bps: 150, fixedCents: 0 },
      serviceFee: {
        enabled: true,
        mode: 'custom',
        custom: { bps: 500, fixedCents: 0 },
      },
    },
  };
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        org_id: orgId,
        account_id: accountId,
        status: 'awaiting_payment',
        expires_at: new Date('2027-01-01T00:00:00Z'),
        pricing_snapshot: snapshot as Json,
      })
      .execute();
    await trx
      .insertInto('payment_accounts')
      .values({
        id: newId(),
        org_id: orgId,
        stripe_account_id: 'acct_frozen',
        charges_enabled: true,
        payouts_enabled: true,
        onboarding_status: 'active',
      })
      .execute();
  });
  const profiles = new PostgresPayerProfileRepository(database);
  expect(await profiles.reserve(accountId)).toEqual({ kind: 'reserved' });
  await profiles.save(accountId, 'cus_frozen');
  await new PostgresCheckoutInvoiceLinker(database, context).link(
    checkoutId,
    invoiceId,
  );
});

afterAll(async () => {
  await database.destroy();
});

describe('frozen checkout charge reader', () => {
  it('reconciles frozen fees, invoice cents, payer and Connect account', async () => {
    const charge = await new PostgresFrozenChargeReader(database, context).load(
      {
        orgId: context.orgId,
        checkoutId,
        invoiceId,
        accountId: context.actor.accountId,
      },
    );
    expect(charge).toMatchObject({
      baseCents: 1000,
      taxCents: 0,
      customerId: 'cus_frozen',
      connectedAccountId: 'acct_frozen',
      autopayAuthorized: false,
    });
    if (!charge) throw new Error('Frozen charge is missing');
    expect(quoteCharge(charge).amountCents).toBe(1050);
  });

  it('rejects a different payer-owned invoice with identical cents', async () => {
    const sameCents = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'checkout',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'registration',
          description: 'Other registration',
          amountCents: 1000,
          refundable: true,
        },
        {
          kind: 'service_fee',
          description: 'Service fee',
          amountCents: 50,
          refundable: true,
        },
      ],
    });
    await expect(
      new PostgresFrozenChargeReader(database, context).load({
        orgId: context.orgId,
        checkoutId,
        invoiceId: sameCents.id,
        accountId: context.actor.accountId,
      }),
    ).rejects.toThrow('Checkout is not payable');
    await expect(
      new PostgresCheckoutInvoiceLinker(database, context).link(
        checkoutId,
        sameCents.id,
      ),
    ).rejects.toThrow('already linked');
  });

  it('fails closed when a frozen amount differs from the invoice', async () => {
    await createWithOrg(database)(context, (trx) =>
      trx
        .updateTable('checkouts')
        .set({ pricing_snapshot: { ...snapshot, serviceFeeCents: 51 } as Json })
        .where('org_id', '=', context.orgId)
        .where('id', '=', checkoutId)
        .execute(),
    );
    await expect(
      new PostgresFrozenChargeReader(database, context).load({
        orgId: context.orgId,
        checkoutId,
        invoiceId,
        accountId: context.actor.accountId,
      }),
    ).rejects.toThrow('does not reconcile');
  });
});
