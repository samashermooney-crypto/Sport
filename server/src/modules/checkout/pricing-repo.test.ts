import { randomUUID } from 'node:crypto';

import type { PricingInput } from '@shared/algorithms/pricing';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { PostgresFrozenChargeReader } from '../finance/frozen-charge-repo.js';
import { PostgresInvoiceRepository } from '../finance/invoice-repo.js';
import { PostgresPayerProfileRepository } from '../finance/payer-repo.js';
import { quoteCharge } from '../finance/service.js';

import { PostgresCheckoutInvoiceLinker } from './invoice-link-repo.js';
import {
  PostgresCheckoutPricingRepository,
  type CheckoutPricingSourceLoader,
} from './pricing-repo.js';
import { CheckoutPricingService } from './pricing.js';

let database: Kysely<DB>;
let context: OrgContext;
let checkoutId: string;

const pricing: PricingInput = {
  nowLocal: '2026-09-27T12:00:00',
  participants: [
    {
      id: 'line-1',
      participantId: 'person-1',
      seasonId: 'season-1',
      offeringId: 'offering-1',
      priceCents: 1000,
    },
  ],
  addOns: [],
  existingConfirmed: [],
  automaticRules: [],
  codes: [],
  aid: [],
  applyCreditCents: 0,
  serviceFee: {
    enabled: true,
    mode: 'custom',
    custom: { bps: 500, fixedCents: 0 },
  },
  productTaxBps: 0,
};

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  checkoutId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `freeze-${randomUUID()}@example.invalid`,
      first_name: 'Freeze',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `freeze-${randomUUID().slice(0, 12)}`,
      name: 'Freeze Test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  await createWithOrg(database)(context, (trx) =>
    trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        org_id: orgId,
        account_id: accountId,
        status: 'open',
        expires_at: new Date('2027-01-01T00:00:00Z'),
        items: { offerings: [{ offeringId: 'offering-1' }] },
      })
      .execute(),
  );
});

afterAll(async () => {
  await database.destroy();
});

describe('durable checkout pricing freeze', () => {
  it('stores one exact source quote and frozen fee terms under the checkout lock', async () => {
    const load = vi
      .fn<CheckoutPricingSourceLoader['load']>()
      .mockResolvedValue({
        pricing,
        paymentTerms: {
          applicationRate: { bps: 150, fixedCents: 0 },
          serviceFee: {
            enabled: true,
            mode: 'custom',
            custom: { bps: 500, fixedCents: 0 },
          },
        },
      });
    const service = new CheckoutPricingService(
      new PostgresCheckoutPricingRepository(database, context, { load }),
    );
    const request = {
      orgId: context.orgId,
      checkoutId,
      idempotencyKey: randomUUID(),
    };
    const [first, replay] = await Promise.all([
      service.freeze(request),
      service.freeze(request),
    ]);
    expect(first).toEqual(replay);
    expect(first.snapshot.chargeNowCents).toBe(1050);
    expect(load).toHaveBeenCalledTimes(1);
    const stored = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('checkouts')
        .select(['status', 'pricing_snapshot', 'idempotency_key'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', checkoutId)
        .executeTakeFirstOrThrow(),
    );
    expect(stored.status).toBe('awaiting_payment');
    expect(stored.idempotency_key).toBe(request.idempotencyKey);
    expect(stored.pricing_snapshot).toMatchObject({
      chargeNowCents: 1050,
      paymentTerms: { applicationRate: { bps: 150, fixedCents: 0 } },
    });
    await expect(
      service.freeze({ ...request, idempotencyKey: randomUUID() }),
    ).rejects.toThrow('another key');
    const invoice = await new PostgresInvoiceRepository(
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
    await new PostgresCheckoutInvoiceLinker(database, context).link(
      checkoutId,
      invoice.id,
    );
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('payment_accounts')
        .values({
          id: newId(),
          org_id: context.orgId,
          stripe_account_id: 'acct_pricing',
          charges_enabled: true,
          payouts_enabled: true,
          onboarding_status: 'active',
        })
        .execute(),
    );
    const profiles = new PostgresPayerProfileRepository(database);
    expect(await profiles.reserve(context.actor.accountId)).toEqual({
      kind: 'reserved',
    });
    await profiles.save(context.actor.accountId, 'cus_pricing');
    const charge = await new PostgresFrozenChargeReader(database, context).load(
      {
        orgId: context.orgId,
        checkoutId,
        invoiceId: invoice.id,
        accountId: context.actor.accountId,
      },
    );
    if (!charge) throw new Error('Frozen charge is unavailable');
    expect(quoteCharge(charge).amountCents).toBe(first.snapshot.chargeNowCents);
  });

  it('refuses fee terms that disagree with the calculated quote', async () => {
    const otherCheckoutId = newId();
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('checkouts')
        .values({
          id: otherCheckoutId,
          org_id: context.orgId,
          account_id: context.actor.accountId,
          status: 'open',
          expires_at: new Date('2027-01-01T00:00:00Z'),
        })
        .execute(),
    );
    const service = new CheckoutPricingService(
      new PostgresCheckoutPricingRepository(database, context, {
        load: () =>
          Promise.resolve({
            pricing,
            paymentTerms: {
              applicationRate: { bps: 150, fixedCents: 0 },
              serviceFee: { enabled: false },
            },
          }),
      }),
    );
    await expect(
      service.freeze({
        orgId: context.orgId,
        checkoutId: otherCheckoutId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('differs from pricing sources');
  });
});
