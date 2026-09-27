import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../../src/db/kysely';
import { createWithOrg } from '../../../src/db/withOrg';
import { bindFixtureInvoice } from '../../../src/modules/checkout/test-fixtures';
import { PostgresPaymentEventRepository } from '../../../src/modules/finance/payment-event-repo';
import { PostgresPaymentRecordStore } from '../../../src/modules/finance/payment-repo';
import { systemWorkerActorId } from '../../../src/modules/jobs/credentials-expiry';
import {
  createProduct,
  createProductCategory,
  listProductCategories,
  listProducts,
  listRegistrationAddOns,
  listStoreOrders,
  placeStoreOrder,
  reconcilePaidStoreOrders,
  receiveStock,
  saveRegistrationAddOn,
  updateProductCategory,
  uniformSizeReport,
} from '../../../src/modules/store/service';
import { createTestFactories } from '../../../test/factories';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => database.destroy());

describe('store inventory ledger', () => {
  it('organizes products with versioned, archiveable tenant categories', async () => {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const category = await createProductCategory(database, actor, {
      name: 'Uniforms',
      sortOrder: 10,
    });
    const productId = await createProduct(database, actor, {
      name: 'Game jersey',
      categoryId: category.id,
      kind: 'uniform',
      requiredForRegistration: true,
      variants: [
        {
          sku: `JERSEY-${randomUUID().slice(0, 8)}`,
          size: 'Youth Large',
          priceCents: 4_500,
        },
      ],
    });
    expect(
      (await listProducts(database, actor)).find(
        (item) => item.id === productId,
      ),
    ).toMatchObject({ categoryId: category.id, categoryName: 'Uniforms' });

    const archived = await updateProductCategory(database, actor, category.id, {
      archived: true,
      expectedVersion: category.version,
    });
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(await listProductCategories(database, actor)).toContainEqual(
      archived,
    );
    await expect(
      createProduct(database, actor, {
        name: 'Archived category item',
        categoryId: category.id,
        kind: 'other',
        requiredForRegistration: false,
        variants: [
          { sku: `ARCH-${randomUUID().slice(0, 8)}`, priceCents: 100 },
        ],
      }),
    ).rejects.toThrow('Product category not found');
  });

  it('exposes tenant-scoped required uniform add-ons and selected sizes to registration', async () => {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const offering = await factories.program(actor);
    const productId = await createProduct(database, actor, {
      name: 'Required game kit',
      kind: 'uniform',
      requiredForRegistration: true,
      variants: [
        {
          sku: `KIT-${randomUUID().slice(0, 8)}`,
          size: 'Youth Large',
          priceCents: 6_000,
        },
      ],
    });
    const variantId = (await listProducts(database, actor)).find(
      (item) => item.id === productId,
    )?.variants[0]?.id;
    if (!variantId) throw new Error('Created game kit variant was not listed');
    await receiveStock(database, actor, variantId, 8);
    const saved = await saveRegistrationAddOn(database, actor, {
      offeringId: offering.offeringId,
      productId,
      required: false,
      quantity: 1,
      active: true,
    });
    const addons = await listRegistrationAddOns(
      database,
      actor,
      offering.offeringId,
    );
    expect(addons).toMatchObject([
      {
        id: saved.id,
        productId,
        productName: 'Required game kit',
        required: true,
        quantity: 1,
        variants: [{ id: variantId, size: 'Youth Large', available: 8 }],
      },
    ]);
    await saveRegistrationAddOn(database, actor, {
      offeringId: offering.offeringId,
      productId,
      required: false,
      quantity: 1,
      active: false,
      expectedVersion: saved.version,
    });
    expect(
      await listRegistrationAddOns(database, actor, offering.offeringId),
    ).toEqual([]);
  });

  it('never reserves more than on-hand stock under concurrent orders', async () => {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const productId = await createProduct(database, actor, {
      name: 'Match jersey',
      kind: 'uniform',
      requiredForRegistration: true,
      variants: [
        {
          sku: `JERSEY-${randomUUID().slice(0, 8)}`,
          size: 'Youth Medium',
          priceCents: 4_500,
        },
      ],
    });
    const product = (await listProducts(database, actor)).find(
      (item) => item.id === productId,
    );
    const variantId = product?.variants[0]?.id;
    if (typeof variantId !== 'string')
      throw new Error('Created uniform variant was not listed');
    await receiveStock(database, actor, variantId, 1);

    const orders = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((idempotencyKey) =>
        placeStoreOrder(database, actor, {
          fulfillmentMethod: 'pickup',
          idempotencyKey,
          lines: [{ variantId, quantity: 1 }],
        }),
      ),
    );
    const fulfilled = orders.filter((result) => result.status === 'fulfilled');
    const rejected = orders.filter((result) => result.status === 'rejected');
    const outcomes = orders.map((result) =>
      result.status === 'fulfilled'
        ? 'fulfilled'
        : result.reason instanceof Error
          ? `${result.reason.name}: ${result.reason.message}`
          : String(result.reason),
    );
    expect(fulfilled, outcomes.join('; ')).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const inventory = (await listProducts(database, actor)).find(
      (item) => item.id === productId,
    )?.variants[0];
    expect(inventory).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
    expect(inventory?.reserved).toBeLessThanOrEqual(inventory?.onHand ?? 0);
  });

  it('deduplicates concurrent retries that use the same idempotency key', async () => {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const productId = await createProduct(database, actor, {
      name: 'Practice shorts',
      kind: 'spirit_wear',
      requiredForRegistration: false,
      variants: [
        {
          sku: `SHORTS-${randomUUID().slice(0, 8)}`,
          size: 'Youth Medium',
          priceCents: 1_800,
        },
      ],
    });
    const variantId = (await listProducts(database, actor)).find(
      (item) => item.id === productId,
    )?.variants[0]?.id;
    if (!variantId) throw new Error('Created shorts variant was not listed');
    await receiveStock(database, actor, variantId, 1);
    const idempotencyKey = randomUUID();
    const orderInput = {
      fulfillmentMethod: 'pickup' as const,
      idempotencyKey,
      lines: [{ variantId, quantity: 1 }],
    };

    const orders = await Promise.all([
      placeStoreOrder(database, actor, orderInput),
      placeStoreOrder(database, actor, orderInput),
    ]);

    expect(orders[0].id).toBe(orders[1].id);
    expect(orders[0].invoiceId).toBe(orders[1].invoiceId);
    const inventory = (await listProducts(database, actor)).find(
      (item) => item.id === productId,
    )?.variants[0];
    expect(inventory).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
  });

  it('recovers an invoice link after an order commit interruption', async () => {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const productId = await createProduct(database, actor, {
      name: 'Warm-up top',
      kind: 'spirit_wear',
      requiredForRegistration: false,
      variants: [
        {
          sku: `TOP-${randomUUID().slice(0, 8)}`,
          size: 'Adult Small',
          priceCents: 2_500,
        },
      ],
    });
    const product = (await listProducts(database, actor)).find(
      (item) => item.id === productId,
    );
    const variantId = product?.variants[0]?.id;
    if (typeof variantId !== 'string')
      throw new Error('Created warm-up variant was not listed');
    await receiveStock(database, actor, variantId, 1);
    const idempotencyKey = randomUUID();
    const original = await placeStoreOrder(database, actor, {
      fulfillmentMethod: 'pickup',
      idempotencyKey,
      lines: [{ variantId, quantity: 1 }],
    });

    await createWithOrg(database)(actor, (trx) =>
      trx
        .updateTable('store_orders')
        .set({ invoice_id: null })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', original.id)
        .execute(),
    );

    const recovered = await placeStoreOrder(database, actor, {
      fulfillmentMethod: 'pickup',
      idempotencyKey,
      lines: [{ variantId, quantity: 1 }],
    });
    const invoiceCount = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('invoices')
        .select((expression) => expression.fn.countAll<number>().as('count'))
        .where('org_id', '=', actor.orgId)
        .where('source', '=', 'order')
        .executeTakeFirstOrThrow(),
    );

    expect(recovered.id).toBe(original.id);
    expect(recovered.invoiceId).toBe(original.invoiceId);
    expect(invoiceCount.count).toBe(1);
  });

  it('requires and snapshots the household shipping address at order placement', async () => {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const householdId = await factories.household(actor);
    const personId = await factories.person(actor, {
      dateOfBirth: '2015-06-01',
    });
    await factories.scoped(actor, async (trx) => {
      await trx
        .insertInto('household_members')
        .values({
          id: randomUUID(),
          org_id: actor.orgId,
          household_id: householdId,
          person_id: personId,
          role: 'athlete',
          financially_responsible: false,
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: randomUUID(),
          org_id: actor.orgId,
          person_id: personId,
          account_id: actor.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
    });
    const productId = await createProduct(database, actor, {
      name: 'Shipped warm-up jacket',
      kind: 'uniform',
      requiredForRegistration: false,
      variants: [
        {
          sku: `JACKET-${randomUUID().slice(0, 8)}`,
          size: 'Youth Large',
          priceCents: 3_500,
        },
      ],
    });
    const variantId = (await listProducts(database, actor)).find(
      (item) => item.id === productId,
    )?.variants[0]?.id;
    if (!variantId) throw new Error('Created jacket variant was not listed');
    await receiveStock(database, actor, variantId, 2);

    await expect(
      placeStoreOrder(database, actor, {
        householdId,
        fulfillmentMethod: 'ship',
        idempotencyKey: randomUUID(),
        lines: [{ variantId, quantity: 1, personId }],
      }),
    ).rejects.toThrow('Enter a valid US shipping address');

    const originalAddress = {
      line1: '12 Field Road',
      city: 'Madison',
      region: 'WI',
      postalCode: '53703',
      country: 'US' as const,
    };
    await createWithOrg(database)(actor, (trx) =>
      trx
        .updateTable('households')
        .set({ address: originalAddress })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', householdId)
        .execute(),
    );
    const order = await placeStoreOrder(database, actor, {
      householdId,
      fulfillmentMethod: 'ship',
      idempotencyKey: randomUUID(),
      lines: [{ variantId, quantity: 1, personId }],
    });
    const savedOrder = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('store_orders')
        .select('shipping_address')
        .where('org_id', '=', actor.orgId)
        .where('id', '=', order.id)
        .executeTakeFirstOrThrow(),
    );
    await createWithOrg(database)(actor, (trx) =>
      trx
        .updateTable('households')
        .set({ address: { ...originalAddress, line1: '99 New Address Ave' } })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', householdId)
        .execute(),
    );

    expect(savedOrder.shipping_address).toEqual(originalAddress);

    const checkoutAddress = {
      line1: '44 Tournament Way',
      line2: 'Unit 5',
      city: 'Madison',
      region: 'WI',
      postalCode: '53704',
      country: 'US' as const,
    };
    const shippedOrder = await placeStoreOrder(database, actor, {
      householdId,
      fulfillmentMethod: 'ship',
      shippingAddress: checkoutAddress,
      idempotencyKey: randomUUID(),
      lines: [{ variantId, quantity: 1, personId }],
    });
    expect(
      (await listStoreOrders(database, actor)).find(
        (item) => item.id === shippedOrder.id,
      ),
    ).toMatchObject({ shippingAddress: checkoutAddress });
  });

  it('reports paid uniform add-on selections by team and size', async () => {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const program = await factories.program(actor);
    const team = await factories.team(actor, program);
    const householdId = await factories.household(actor);
    const playerOneId = await factories.person(actor, {
      firstName: 'Riley',
      lastName: 'Uniform',
    });
    const playerTwoId = await factories.person(actor, {
      firstName: 'Sam',
      lastName: 'Uniform',
    });
    const registrationOneId = await factories.registration(
      actor,
      program,
      playerOneId,
      householdId,
    );
    const registrationTwoId = await factories.registration(
      actor,
      program,
      playerTwoId,
      householdId,
    );
    await factories.scoped(actor, async (trx) => {
      for (const personId of [playerOneId, playerTwoId]) {
        await trx
          .insertInto('household_members')
          .values({
            id: randomUUID(),
            org_id: actor.orgId,
            household_id: householdId,
            person_id: personId,
            role: 'athlete',
            financially_responsible: true,
          })
          .execute();
        await trx
          .insertInto('person_account_links')
          .values({
            id: randomUUID(),
            org_id: actor.orgId,
            person_id: personId,
            account_id: actor.accountId,
            relationship: 'guardian',
            verified_at: new Date(),
          })
          .execute();
      }
      await trx
        .updateTable('registrations')
        .set({ team_season_id: team.teamSeasonId })
        .where('org_id', '=', actor.orgId)
        .where('id', 'in', [registrationOneId, registrationTwoId])
        .execute();
    });

    const productId = await createProduct(database, actor, {
      name: 'Team game uniform',
      kind: 'uniform',
      requiredForRegistration: true,
      variants: [
        {
          sku: `UNIFORM-S-${randomUUID().slice(0, 8)}`,
          size: 'Youth Small',
          priceCents: 4_500,
        },
        {
          sku: `UNIFORM-M-${randomUUID().slice(0, 8)}`,
          size: 'Youth Medium',
          priceCents: 4_500,
        },
      ],
    });
    const product = (await listProducts(database, actor)).find(
      (item) => item.id === productId,
    );
    const small = product?.variants.find(
      (variant) => variant.size === 'Youth Small',
    );
    const medium = product?.variants.find(
      (variant) => variant.size === 'Youth Medium',
    );
    if (!small || !medium) throw new Error('Uniform sizes were not created');
    await receiveStock(database, actor, small.id, 5);
    await receiveStock(database, actor, medium.id, 5);
    await saveRegistrationAddOn(database, actor, {
      offeringId: program.offeringId,
      productId,
      required: true,
      quantity: 1,
      active: true,
    });

    const orders = await Promise.all([
      placeStoreOrder(database, actor, {
        householdId,
        registrationId: registrationOneId,
        teamSeasonId: team.teamSeasonId,
        fulfillmentMethod: 'pickup',
        idempotencyKey: randomUUID(),
        lines: [{ variantId: small.id, quantity: 2, personId: playerOneId }],
      }),
      placeStoreOrder(database, actor, {
        householdId,
        registrationId: registrationTwoId,
        teamSeasonId: team.teamSeasonId,
        fulfillmentMethod: 'pickup',
        idempotencyKey: randomUUID(),
        lines: [{ variantId: medium.id, quantity: 1, personId: playerTwoId }],
      }),
    ]);
    for (const order of orders) {
      const checkoutId = randomUUID();
      const amountCents = order.subtotalCents + order.taxCents;
      await createWithOrg(database)(actor, (trx) =>
        trx
          .insertInto('checkouts')
          .values({
            id: checkoutId,
            org_id: actor.orgId,
            account_id: actor.accountId,
            status: 'awaiting_payment',
            expires_at: new Date(Date.now() + 86_400_000),
            pricing_snapshot: { totalCents: amountCents },
          })
          .execute(),
      );
      await bindFixtureInvoice(database, actor, checkoutId, order.invoiceId);
      const paymentIntentId = `pi_${randomUUID()}`;
      await new PostgresPaymentRecordStore(database, actor).recordPending({
        orgId: actor.orgId,
        checkoutId,
        invoiceId: order.invoiceId,
        accountId: actor.accountId,
        paymentIntentId,
        amountCents,
        applicationFeeCents: 0,
        idempotencyKey: randomUUID(),
      });
      await new PostgresPaymentEventRepository(
        database,
        systemWorkerActorId,
      ).applyLatest({
        orgId: actor.orgId,
        paymentIntentId,
        latest: {
          id: paymentIntentId,
          clientSecret: null,
          status: 'succeeded',
          amountCents,
          latestChargeId: `ch_${randomUUID()}`,
          method: 'card',
        },
      });
    }
    expect(await reconcilePaidStoreOrders(database, actor)).toBe(2);

    await expect(
      uniformSizeReport(database, actor, {
        teamSeasonId: team.teamSeasonId,
        programId: program.programId,
      }),
    ).resolves.toEqual([
      {
        teamSeasonId: team.teamSeasonId,
        productName: 'Team game uniform',
        size: 'Youth Medium',
        quantity: 1,
      },
      {
        teamSeasonId: team.teamSeasonId,
        productName: 'Team game uniform',
        size: 'Youth Small',
        quantity: 2,
      },
    ]);
  });
});
