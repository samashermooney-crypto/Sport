import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../../src/db/kysely';
import { createWithOrg } from '../../../src/db/withOrg';
import {
  createProduct,
  createProductCategory,
  listProductCategories,
  listProducts,
  listRegistrationAddOns,
  placeStoreOrder,
  receiveStock,
  saveRegistrationAddOn,
  updateProductCategory,
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
});
