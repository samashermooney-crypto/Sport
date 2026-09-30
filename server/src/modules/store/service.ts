import { createHash } from 'node:crypto';

import { newId } from '@shared/ids';
import { percentOf } from '@shared/money';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';
import { PostgresInvoiceRepository } from '../finance/invoice-repo';
import { systemWorkerActorId } from '../jobs/credentials-expiry';
import { isNotificationType } from '../notifications/catalog';
import { createNotification } from '../notifications/service';

import { shippingAddressSchema } from './schema';

class StoreConflictError extends Error {
  readonly status = 409;
  readonly code = 'CONFLICT';
}
class StoreNotFoundError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
}
class StoreAccessError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
}

interface StoreProductVariant {
  id: string;
  sku: string;
  size: string | null;
  color: string | null;
  priceCents: number;
  taxRateId: string | null;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number | null;
}

interface StoreProduct {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  kind: 'uniform' | 'spirit_wear' | 'other';
  requiredForRegistration: boolean;
  active: boolean;
  variants: StoreProductVariant[];
}

interface RegistrationAddOnVariant {
  id: string;
  sku: string;
  size: string | null;
  color: string | null;
  priceCents: number;
  available: number;
}

function presentProductCategory(row: {
  id: string;
  name: string;
  sort_order: number;
  archived_at: Date | string | null;
  version: number;
}) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    archivedAt:
      row.archived_at instanceof Date
        ? row.archived_at.toISOString()
        : row.archived_at,
    version: row.version,
  };
}

export async function createProductCategory(
  database: Kysely<DB>,
  context: OrgContext,
  input: { name: string; sortOrder?: number | undefined },
) {
  return createWithOrg(database)(context, async (trx) => {
    const category = await trx
      .insertInto('product_categories')
      .values({
        org_id: context.orgId,
        name: input.name.trim(),
        sort_order: input.sortOrder ?? 0,
      })
      .returning(['id', 'name', 'sort_order', 'archived_at', 'version'])
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'store.product_category_created',
      entityType: 'product_category',
      entityId: category.id,
      changes: {
        name: { tier: 'internal', after: category.name },
      },
    });
    return presentProductCategory(category);
  });
}

export async function listProductCategories(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, async (trx) => {
    const rows = await trx
      .selectFrom('product_categories')
      .select(['id', 'name', 'sort_order', 'archived_at', 'version'])
      .where('org_id', '=', context.orgId)
      .orderBy('archived_at', 'asc')
      .orderBy('sort_order')
      .orderBy('name')
      .execute();
    return rows.map(presentProductCategory);
  });
}

export async function updateProductCategory(
  database: Kysely<DB>,
  context: OrgContext,
  categoryId: string,
  input: {
    name?: string | undefined;
    sortOrder?: number | undefined;
    archived?: boolean | undefined;
    expectedVersion: number;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    const category = await trx
      .updateTable('product_categories')
      .set({
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.sortOrder === undefined
          ? {}
          : { sort_order: input.sortOrder }),
        ...(input.archived === undefined
          ? {}
          : { archived_at: input.archived ? new Date() : null }),
        version: sql`version + 1`,
        updated_at: new Date(),
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', categoryId)
      .where('version', '=', input.expectedVersion)
      .returning(['id', 'name', 'sort_order', 'archived_at', 'version'])
      .executeTakeFirst();
    if (!category)
      throw new StoreConflictError(
        'Product category was updated by another user',
      );
    await appendAuditEvent(trx, context, {
      action: input.archived
        ? 'store.product_category_archived'
        : 'store.product_category_updated',
      entityType: 'product_category',
      entityId: category.id,
      changes: {
        name: { tier: 'internal', after: category.name },
        sortOrder: { tier: 'internal', after: category.sort_order },
        archived: { tier: 'internal', after: category.archived_at !== null },
      },
    });
    return presentProductCategory(category);
  });
}

export async function saveRegistrationAddOn(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    offeringId: string;
    productId: string;
    required: boolean;
    quantity: number;
    active: boolean;
    expectedVersion?: number | undefined;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    const offering = await trx
      .selectFrom('registration_offerings')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.offeringId)
      .executeTakeFirst();
    const product = await trx
      .selectFrom('products')
      .select(['id', 'required_for_registration'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.productId)
      .where('active', '=', true)
      .executeTakeFirst();
    if (!offering || !product)
      throw new StoreNotFoundError(
        'Registration offering or product not found',
      );
    const existing = await trx
      .selectFrom('store_registration_addons')
      .select(['id', 'version'])
      .where('org_id', '=', context.orgId)
      .where('offering_id', '=', input.offeringId)
      .where('product_id', '=', input.productId)
      .forUpdate()
      .executeTakeFirst();
    const required = input.required || product.required_for_registration;
    let addon;
    if (existing) {
      if (input.expectedVersion !== existing.version)
        throw new StoreConflictError(
          'Registration add-on changed; reload before updating',
        );
      addon = await trx
        .updateTable('store_registration_addons')
        .set({
          required,
          quantity: input.quantity,
          active: input.active,
          version: sql`version + 1`,
          updated_at: new Date(),
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', existing.id)
        .where('version', '=', existing.version)
        .returning(['id', 'version'])
        .executeTakeFirst();
      if (!addon)
        throw new StoreConflictError(
          'Registration add-on changed; reload before updating',
        );
    } else {
      if (input.expectedVersion !== undefined)
        throw new StoreConflictError('Registration add-on no longer exists');
      addon = await trx
        .insertInto('store_registration_addons')
        .values({
          org_id: context.orgId,
          offering_id: input.offeringId,
          product_id: input.productId,
          required,
          quantity: input.quantity,
          active: input.active,
        })
        .returning(['id', 'version'])
        .executeTakeFirstOrThrow();
    }
    await appendAuditEvent(trx, context, {
      action: 'store.registration_addon_saved',
      entityType: 'store_registration_addon',
      entityId: addon.id,
      changes: {
        offeringId: { tier: 'internal', after: input.offeringId },
        productId: { tier: 'internal', after: input.productId },
        required: { tier: 'internal', after: required },
        quantity: { tier: 'internal', after: input.quantity },
        active: { tier: 'internal', after: input.active },
      },
    });
    return { id: addon.id, version: addon.version };
  });
}

export async function listRegistrationAddOns(
  database: Kysely<DB>,
  context: OrgContext,
  offeringId: string,
) {
  return createWithOrg(database)(context, async (trx) => {
    const offering = await trx
      .selectFrom('registration_offerings')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', offeringId)
      .executeTakeFirst();
    if (!offering)
      throw new StoreNotFoundError('Registration offering not found');
    const rows = await sql<{
      addon_id: string;
      product_id: string;
      product_name: string;
      kind: 'uniform' | 'spirit_wear' | 'other';
      required: boolean;
      quantity: number;
      version: number;
      variant_id: string | null;
      sku: string | null;
      size: string | null;
      color: string | null;
      price_cents: number | null;
      available: number | null;
    }>`
      SELECT addon.id AS addon_id, product.id AS product_id,
        product.name AS product_name, product.kind, addon.required,
        addon.quantity, addon.version, variant.id AS variant_id,
        variant.sku, variant.size, variant.color, variant.price_cents,
        COALESCE(balance.available, 0)::int AS available
      FROM store_registration_addons addon
      JOIN products product
        ON product.org_id = addon.org_id AND product.id = addon.product_id
        AND product.active = true
      LEFT JOIN product_variants variant
        ON variant.org_id = product.org_id AND variant.product_id = product.id
        AND variant.archived_at IS NULL
      LEFT JOIN inventory_balances balance
        ON balance.org_id = variant.org_id AND balance.product_variant_id = variant.id
      WHERE addon.org_id = ${context.orgId}::uuid
        AND addon.offering_id = ${offeringId}::uuid
        AND addon.active = true
      ORDER BY addon.required DESC, product.name, variant.size, variant.sku
    `.execute(trx);
    const addons = new Map<
      string,
      {
        id: string;
        productId: string;
        productName: string;
        kind: 'uniform' | 'spirit_wear' | 'other';
        required: boolean;
        quantity: number;
        version: number;
        variants: RegistrationAddOnVariant[];
      }
    >();
    for (const row of rows.rows) {
      let addon = addons.get(row.addon_id);
      if (!addon) {
        addon = {
          id: row.addon_id,
          productId: row.product_id,
          productName: row.product_name,
          kind: row.kind,
          required: row.required,
          quantity: row.quantity,
          version: row.version,
          variants: [],
        };
        addons.set(row.addon_id, addon);
      }
      if (row.variant_id && row.sku !== null && row.price_cents !== null)
        addon.variants.push({
          id: row.variant_id,
          sku: row.sku,
          size: row.size,
          color: row.color,
          priceCents: row.price_cents,
          available: row.available ?? 0,
        });
    }
    return [...addons.values()];
  });
}

async function issueOrderInvoice(
  database: Kysely<DB>,
  context: OrgContext,
  orderId: string,
  idempotencyKey: string,
  now: Date,
) {
  const withOrg = createWithOrg(database);
  const snapshot = await withOrg(context, async (trx) => {
    const order = await trx
      .selectFrom('store_orders')
      .select([
        'account_id',
        'household_id',
        'subtotal_cents',
        'tax_cents',
        'tax_rate_bps',
        'status',
        'invoice_id',
      ])
      .where('org_id', '=', context.orgId)
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order || order.status === 'canceled' || order.status === 'draft')
      throw new StoreConflictError('Store order cannot be invoiced');
    if (order.invoice_id) return { order, lines: [] };
    const lines = await trx
      .selectFrom('store_order_lines')
      .select(['description', 'amount_cents'])
      .where('org_id', '=', context.orgId)
      .where('order_id', '=', orderId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    if (!lines.length)
      throw new StoreConflictError('Store order has no invoice lines');
    return { order, lines };
  });
  if (snapshot.order.invoice_id) return snapshot.order.invoice_id;
  const issued = await new PostgresInvoiceRepository(database, context).issue({
    orgId: context.orgId,
    accountId: snapshot.order.account_id,
    ...(snapshot.order.household_id
      ? { householdId: snapshot.order.household_id }
      : {}),
    source: 'order',
    creationKey: idempotencyKey,
    memo: 'Store order',
    lines: [
      ...snapshot.lines.map((line) => ({
        kind: 'product' as const,
        description: line.description,
        amountCents: line.amount_cents,
        refundable: true,
      })),
      ...(snapshot.order.tax_cents > 0
        ? [
            {
              kind: 'tax' as const,
              description: 'Sales tax',
              amountCents: snapshot.order.tax_cents,
              refundable: true,
              taxRateBps: snapshot.order.tax_rate_bps,
            },
          ]
        : []),
    ],
  });
  await withOrg(context, async (trx) => {
    await trx
      .updateTable('store_orders')
      .set({ invoice_id: issued.id, updated_at: now })
      .where('org_id', '=', context.orgId)
      .where('id', '=', orderId)
      .where('invoice_id', 'is', null)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'store.order_placed',
      entityType: 'store_order',
      entityId: orderId,
      changes: {
        subtotalCents: {
          tier: 'internal',
          after: snapshot.order.subtotal_cents,
        },
        taxCents: { tier: 'internal', after: snapshot.order.tax_cents },
        invoiceId: { tier: 'internal', after: issued.id },
      },
    });
  });
  return issued.id;
}

interface ExistingStoreOrder {
  id: string;
  invoice_id: string | null;
  subtotal_cents: number;
  tax_cents: number;
  status: string;
  request_hash: string;
}

async function replayStoreOrder(
  database: Kysely<DB>,
  context: OrgContext,
  existing: ExistingStoreOrder,
  requestHash: string,
  idempotencyKey: string,
  now: Date,
) {
  if (existing.request_hash !== requestHash)
    throw new StoreConflictError(
      'Store order idempotency key was already used with different details',
    );
  if (existing.status === 'canceled')
    throw new StoreConflictError('Store order was canceled');
  const invoiceId =
    existing.invoice_id ??
    (await issueOrderInvoice(
      database,
      context,
      existing.id,
      idempotencyKey,
      now,
    ));
  const linked = await createWithOrg(database)(context, (trx) =>
    trx
      .selectFrom('store_orders')
      .select(['id', 'invoice_id', 'subtotal_cents', 'tax_cents', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', existing.id)
      .executeTakeFirstOrThrow(),
  );
  return {
    id: linked.id,
    invoiceId: linked.invoice_id ?? invoiceId,
    subtotalCents: linked.subtotal_cents,
    taxCents: linked.tax_cents,
    status: linked.status,
  };
}

export async function createProduct(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    name: string;
    description?: string | null | undefined;
    categoryId?: string | null | undefined;
    kind: 'uniform' | 'spirit_wear' | 'other';
    requiredForRegistration: boolean;
    variants: {
      sku: string;
      size?: string | null | undefined;
      color?: string | null | undefined;
      priceCents: number;
      taxRateId?: string | null | undefined;
      lowStockThreshold?: number | null | undefined;
    }[];
  },
) {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    if (input.categoryId) {
      const category = await trx
        .selectFrom('product_categories')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.categoryId)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (!category) throw new StoreNotFoundError('Product category not found');
    }
    const productId = newId();
    await trx
      .insertInto('products')
      .values({
        id: productId,
        org_id: context.orgId,
        category_id: input.categoryId ?? null,
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        required_for_registration: input.requiredForRegistration,
        active: true,
        created_by: context.actor.accountId,
      })
      .execute();
    for (const variant of input.variants) {
      await sql`INSERT INTO product_variants (id, org_id, product_id, sku, size, color, price_cents, tax_rate_id, low_stock_threshold)
        VALUES (${newId()}, ${context.orgId}, ${productId}, ${variant.sku}, ${variant.size ?? null}, ${variant.color ?? null}, ${variant.priceCents}, ${variant.taxRateId ?? null}, ${variant.lowStockThreshold ?? null})`.execute(
        trx,
      );
    }
    await appendAuditEvent(trx, context, {
      action: 'store.product_created',
      entityType: 'product',
      entityId: productId,
      changes: {
        name: { tier: 'internal', after: input.name },
        variantCount: { tier: 'internal', after: input.variants.length },
      },
    });
    return productId;
  });
}

export async function listProducts(database: Kysely<DB>, context: OrgContext) {
  return createWithOrg(database)(context, async (trx) => {
    const result = await sql<{
      id: string;
      name: string;
      description: string | null;
      category_id: string | null;
      category_name: string | null;
      kind: 'uniform' | 'spirit_wear' | 'other';
      required_for_registration: boolean;
      active: boolean;
      variant_id: string | null;
      sku: string;
      size: string | null;
      color: string | null;
      price_cents: number;
      tax_rate_id: string | null;
      on_hand: number;
      reserved: number;
      available: number;
      low_stock_threshold: number | null;
    }>`SELECT product.id, product.name, product.description, product.category_id,
       category.name AS category_name, product.kind, product.required_for_registration, product.active,
       variant.id AS variant_id, variant.sku, variant.size, variant.color, variant.price_cents, variant.tax_rate_id, variant.low_stock_threshold,
       COALESCE(balance.on_hand, 0)::int AS on_hand, COALESCE(balance.reserved, 0)::int AS reserved, COALESCE(balance.available, 0)::int AS available
      FROM products product LEFT JOIN product_categories category ON category.org_id = product.org_id AND category.id = product.category_id
      LEFT JOIN product_variants variant ON variant.org_id = product.org_id AND variant.product_id = product.id AND variant.archived_at IS NULL
      LEFT JOIN inventory_balances balance ON balance.org_id = variant.org_id AND balance.product_variant_id = variant.id
      WHERE product.org_id = ${context.orgId} AND product.active = true ORDER BY product.name, variant.sku`.execute(
      trx,
    );
    const products = new Map<string, StoreProduct>();
    for (const row of result.rows) {
      let product = products.get(row.id);
      if (!product) {
        product = {
          id: row.id,
          name: row.name,
          description: row.description,
          categoryId: row.category_id,
          categoryName: row.category_name,
          kind: row.kind,
          requiredForRegistration: row.required_for_registration,
          active: row.active,
          variants: [],
        };
        products.set(row.id, product);
      }
      if (row.variant_id)
        product.variants.push({
          id: row.variant_id,
          sku: row.sku,
          size: row.size,
          color: row.color,
          priceCents: row.price_cents,
          taxRateId: row.tax_rate_id,
          onHand: row.on_hand,
          reserved: row.reserved,
          available: row.available,
          lowStockThreshold: row.low_stock_threshold,
        });
    }
    return [...products.values()];
  });
}

export async function receiveStock(
  database: Kysely<DB>,
  context: OrgContext,
  variantId: string,
  quantity: number,
  memo?: string,
) {
  return createWithOrg(database)(context, async (trx) => {
    const result = await sql<{
      id: string;
    }>`INSERT INTO inventory_movements (org_id, product_variant_id, movement, quantity, memo, created_by)
      SELECT ${context.orgId}, variant.id, 'receive', ${quantity}, ${memo ?? null}, ${context.actor.accountId}
      FROM product_variants variant JOIN products product ON product.org_id = variant.org_id AND product.id = variant.product_id
      WHERE variant.org_id = ${context.orgId} AND variant.id = ${variantId} AND variant.archived_at IS NULL AND product.active
      RETURNING id`.execute(trx);
    if (!result.rows[0])
      throw new StoreNotFoundError('Product variant not found');
    return result.rows[0].id;
  });
}

export async function placeStoreOrder(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    householdId?: string | null | undefined;
    registrationId?: string | null | undefined;
    teamSeasonId?: string | null | undefined;
    fulfillmentMethod: 'pickup' | 'ship';
    shippingAddress?: z.output<typeof shippingAddressSchema> | undefined;
    idempotencyKey: string;
    lines: {
      variantId: string;
      quantity: number;
      personId?: string | null | undefined;
    }[];
  },
  now = new Date(),
) {
  const withOrg = createWithOrg(database);
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        orgId: context.orgId,
        accountId: context.actor.accountId,
        householdId: input.householdId ?? null,
        registrationId: input.registrationId ?? null,
        teamSeasonId: input.teamSeasonId ?? null,
        fulfillmentMethod: input.fulfillmentMethod,
        shippingAddress: input.shippingAddress ?? null,
        lines: input.lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          personId: line.personId ?? null,
        })),
      }),
    )
    .digest('hex');
  const existing = await withOrg(context, (trx) =>
    trx
      .selectFrom('store_orders')
      .select([
        'id',
        'invoice_id',
        'subtotal_cents',
        'tax_cents',
        'status',
        'request_hash',
      ])
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst(),
  );
  if (existing)
    return replayStoreOrder(
      database,
      context,
      existing,
      requestHash,
      input.idempotencyKey,
      now,
    );
  const orderId = newId();
  type OrderLine = {
    id: string;
    amountCents: number;
    description: string;
    productId: string;
    variantId: string;
    quantity: number;
    personId: string | null;
    teamSeasonId: string | null;
  };
  let order: {
    subtotalCents: number;
    taxCents: number;
    taxRateBps: number;
    lineItems: OrderLine[];
  };
  try {
    order = await withOrg(context, async (trx) => {
      const account = await trx
        .selectFrom('accounts')
        .select('id')
        .where('id', '=', context.actor.accountId)
        .executeTakeFirst();
      if (!account)
        throw new StoreAccessError('A signed-in purchaser is required');
      const selectedRegistrationId = input.registrationId ?? null;
      let selectedTeamSeasonId = input.teamSeasonId ?? null;
      if (input.householdId) {
        const membership = await sql<{ allowed: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM household_members household_member
            JOIN person_account_links link ON link.org_id = household_member.org_id
              AND link.person_id = household_member.person_id
              AND link.account_id = ${context.actor.accountId}::uuid
              AND link.revoked_at IS NULL
              AND (link.relationship <> 'guardian' OR link.verified_at IS NOT NULL)
            WHERE household_member.org_id = ${context.orgId}::uuid
              AND household_member.household_id = ${input.householdId}::uuid
              AND household_member.removed_at IS NULL
          ) AS allowed`.execute(trx);
        if (!membership.rows[0]?.allowed)
          throw new StoreAccessError('Household not available to purchaser');
      }
      if (input.registrationId) {
        const registration = await trx
          .selectFrom('registrations')
          .select(['id', 'person_id', 'team_season_id'])
          .where('org_id', '=', context.orgId)
          .where('id', '=', input.registrationId)
          .where('household_id', '=', input.householdId ?? null)
          .where('status', 'in', ['confirmed', 'pending_payment'])
          .executeTakeFirst();
        if (!registration)
          throw new StoreNotFoundError(
            'Registration not found for this household',
          );
        if (
          input.teamSeasonId &&
          input.teamSeasonId !== registration.team_season_id
        )
          throw new StoreConflictError(
            'Selected team does not match the registration',
          );
        for (const line of input.lines) {
          if (line.personId && line.personId !== registration.person_id)
            throw new StoreConflictError(
              'Selected registration does not match the order participant',
            );
        }
        const personLink = await trx
          .selectFrom('person_account_links')
          .select('person_id')
          .where('org_id', '=', context.orgId)
          .where('person_id', '=', registration.person_id)
          .where('account_id', '=', context.actor.accountId)
          .where('relationship', 'in', ['self', 'guardian'])
          .where('revoked_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('relationship', '!=', 'guardian'),
              eb('verified_at', 'is not', null),
            ]),
          )
          .executeTakeFirst();
        if (!personLink)
          throw new StoreAccessError(
            'Selected registration is not available to the purchaser',
          );
        selectedTeamSeasonId ??= registration.team_season_id;
      }
      let shippingAddress: Json | null = null;
      if (input.fulfillmentMethod === 'ship') {
        if (!input.householdId)
          throw new StoreConflictError(
            'Choose a household with a saved shipping address',
          );
        const household = await trx
          .selectFrom('households')
          .select('address')
          .where('org_id', '=', context.orgId)
          .where('id', '=', input.householdId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!household)
          throw new StoreConflictError(
            'Choose an active household before ordering',
          );
        const parsedAddress = shippingAddressSchema.safeParse(
          input.shippingAddress ?? household.address,
        );
        if (!parsedAddress.success)
          throw new StoreConflictError(
            'Enter a valid US shipping address before ordering',
          );
        shippingAddress = parsedAddress.data;
      }
      await trx
        .insertInto('store_orders')
        .values({
          id: orderId,
          org_id: context.orgId,
          account_id: context.actor.accountId,
          household_id: input.householdId ?? null,
          shipping_address: shippingAddress,
          registration_id: selectedRegistrationId,
          team_season_id: selectedTeamSeasonId,
          status: 'draft',
          idempotency_key: input.idempotencyKey,
          request_hash: requestHash,
        })
        .execute();
      const lines: OrderLine[] = [];
      let subtotalCents = 0;
      let taxableSubtotalCents = 0;
      const taxRates = new Set<number>();
      for (const requested of input.lines) {
        const variant = await sql<{
          product_id: string;
          sku: string;
          name: string;
          price_cents: number;
          tax_rate_id: string | null;
          rate_bps: number | null;
        }>`
          SELECT variant.product_id, variant.sku, product.name, variant.price_cents, variant.tax_rate_id, tax.rate_bps
          FROM product_variants variant JOIN products product ON product.org_id = variant.org_id AND product.id = variant.product_id
          LEFT JOIN tax_rates tax ON tax.org_id = variant.org_id AND tax.id = variant.tax_rate_id AND tax.active = true
          WHERE variant.org_id = ${context.orgId} AND variant.id = ${requested.variantId} AND variant.archived_at IS NULL AND product.active`.execute(
          trx,
        );
        const item = variant.rows[0];
        if (!item) throw new StoreNotFoundError('Product variant not found');
        if (item.tax_rate_id && item.rate_bps === null)
          throw new StoreConflictError(
            'Configured product tax rate is inactive',
          );
        if (requested.personId) {
          const participant = await trx
            .selectFrom('household_members')
            .select('id')
            .where('org_id', '=', context.orgId)
            .where('household_id', '=', input.householdId ?? null)
            .where('person_id', '=', requested.personId)
            .where('removed_at', 'is', null)
            .executeTakeFirst();
          if (!participant)
            throw new StoreAccessError(
              'Order participant is outside the selected household',
            );
        }
        const amountCents = item.price_cents * requested.quantity;
        if (!Number.isSafeInteger(amountCents))
          throw new RangeError('Order amount exceeds supported limit');
        subtotalCents += amountCents;
        taxRates.add(item.rate_bps ?? 0);
        if (item.rate_bps) taxableSubtotalCents += amountCents;
        const lineId = newId();
        await trx
          .insertInto('store_order_lines')
          .values({
            id: lineId,
            org_id: context.orgId,
            order_id: orderId,
            product_id: item.product_id,
            product_variant_id: requested.variantId,
            registration_id: selectedRegistrationId,
            person_id: requested.personId ?? null,
            team_season_id: selectedTeamSeasonId,
            quantity: requested.quantity,
            unit_amount_cents: item.price_cents,
            amount_cents: amountCents,
            description: `${item.name} (${item.sku})`,
          })
          .execute();
        await trx
          .insertInto('inventory_movements')
          .values({
            org_id: context.orgId,
            product_variant_id: requested.variantId,
            movement: 'reserve',
            quantity: requested.quantity,
            order_line_id: lineId,
            memo: 'Store order reservation',
            created_by: context.actor.accountId,
          })
          .execute();
        lines.push({
          id: lineId,
          amountCents,
          description: `${item.name} (${item.sku})`,
          productId: item.product_id,
          variantId: requested.variantId,
          quantity: requested.quantity,
          personId: requested.personId ?? null,
          teamSeasonId: selectedTeamSeasonId,
        });
      }
      if (taxRates.size > 1)
        throw new StoreConflictError(
          'Products with different tax rates must be ordered separately',
        );
      const taxRateBps = [...taxRates][0] ?? 0;
      const taxCents = taxRateBps
        ? percentOf(taxableSubtotalCents, taxRateBps)
        : 0;
      await trx
        .updateTable('store_orders')
        .set({
          status: 'awaiting_payment',
          subtotal_cents: subtotalCents,
          tax_cents: taxCents,
          tax_rate_bps: taxRateBps,
          updated_at: now,
        })
        .where('org_id', '=', context.orgId)
        .where('id', '=', orderId)
        .execute();
      await trx
        .insertInto('store_fulfillments')
        .values({
          org_id: context.orgId,
          order_id: orderId,
          method: input.fulfillmentMethod,
          status: 'pending',
        })
        .execute();
      return { subtotalCents, taxCents, taxRateBps, lineItems: lines };
    });
  } catch (error) {
    const pgError =
      error instanceof Error && 'code' in error && 'constraint' in error
        ? (error as Error & { code: string; constraint?: string })
        : null;
    if (
      pgError?.code === '23505' &&
      pgError.constraint ===
        'store_orders_org_id_account_id_idempotency_key_key'
    ) {
      const concurrent = await withOrg(context, (trx) =>
        trx
          .selectFrom('store_orders')
          .select([
            'id',
            'invoice_id',
            'subtotal_cents',
            'tax_cents',
            'status',
            'request_hash',
          ])
          .where('org_id', '=', context.orgId)
          .where('account_id', '=', context.actor.accountId)
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst(),
      );
      if (concurrent)
        return replayStoreOrder(
          database,
          context,
          concurrent,
          requestHash,
          input.idempotencyKey,
          now,
        );
    }
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === '23514' &&
      error.message.includes('inventory')
    ) {
      throw new StoreConflictError('Not enough inventory is available');
    }
    throw error;
  }
  let issued: Awaited<ReturnType<PostgresInvoiceRepository['issue']>>;
  try {
    issued = await new PostgresInvoiceRepository(database, context).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      ...(input.householdId ? { householdId: input.householdId } : {}),
      source: 'order',
      creationKey: input.idempotencyKey,
      memo: 'Store order',
      lines: [
        ...order.lineItems.map((line) => ({
          kind: 'product' as const,
          description: line.description,
          amountCents: line.amountCents,
          refundable: true,
        })),
        ...(order.taxCents > 0
          ? [
              {
                kind: 'tax' as const,
                description: 'Sales tax',
                amountCents: order.taxCents,
                refundable: true,
                taxRateBps: order.taxRateBps,
              },
            ]
          : []),
      ],
    });
  } catch (error) {
    await withOrg(context, async (trx) => {
      for (const line of order.lineItems)
        await trx
          .insertInto('inventory_movements')
          .values({
            org_id: context.orgId,
            product_variant_id: line.variantId,
            movement: 'release',
            quantity: line.quantity,
            order_line_id: line.id,
            memo: 'Order invoice creation failed',
            created_by: context.actor.accountId,
          })
          .execute();
      await trx
        .updateTable('store_orders')
        .set({ status: 'canceled' })
        .where('org_id', '=', context.orgId)
        .where('id', '=', orderId)
        .execute();
    });
    throw error;
  }
  await withOrg(context, async (trx) => {
    await trx
      .updateTable('store_orders')
      .set({ invoice_id: issued.id, updated_at: now })
      .where('org_id', '=', context.orgId)
      .where('id', '=', orderId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'store.order_placed',
      entityType: 'store_order',
      entityId: orderId,
      changes: {
        subtotalCents: { tier: 'internal', after: order.subtotalCents },
        taxCents: { tier: 'internal', after: order.taxCents },
        invoiceId: { tier: 'internal', after: issued.id },
      },
    });
  });
  return {
    id: orderId,
    invoiceId: issued.id,
    subtotalCents: order.subtotalCents,
    taxCents: order.taxCents,
    status: 'awaiting_payment' as const,
  };
}

export async function reconcilePaidStoreOrders(
  database: Kysely<DB>,
  context: OrgContext,
  now = new Date(),
) {
  return createWithOrg(database)(context, async (trx) => {
    const rows = await sql<{
      order_id: string;
      line_id: string;
      variant_id: string;
      quantity: number;
    }>`
      SELECT store_order.id AS order_id, line.id AS line_id, line.product_variant_id AS variant_id, line.quantity
      FROM store_orders store_order JOIN invoices invoice ON invoice.org_id = store_order.org_id AND invoice.id = store_order.invoice_id
      JOIN store_order_lines line ON line.org_id = store_order.org_id AND line.order_id = store_order.id
      WHERE store_order.org_id = ${context.orgId} AND store_order.status = 'awaiting_payment' AND invoice.status = 'paid'
      ORDER BY store_order.created_at FOR UPDATE OF store_order SKIP LOCKED`.execute(
      trx,
    );
    for (const row of rows.rows) {
      await trx
        .insertInto('inventory_movements')
        .values({
          org_id: context.orgId,
          product_variant_id: row.variant_id,
          movement: 'sell',
          quantity: row.quantity,
          order_line_id: row.line_id,
          memo: 'Paid store order',
          created_by: context.actor.accountId,
        })
        .execute();
      await trx
        .updateTable('store_orders')
        .set({ status: 'paid', updated_at: now })
        .where('org_id', '=', context.orgId)
        .where('id', '=', row.order_id)
        .execute();
    }
    return rows.rows.length;
  });
}

export async function updateFulfillment(
  database: Kysely<DB>,
  context: OrgContext,
  orderId: string,
  input: {
    status: 'ready' | 'shipped' | 'picked_up' | 'canceled';
    trackingNumber?: string | null | undefined;
    expectedVersion: number;
  },
  now = new Date(),
) {
  return createWithOrg(database)(context, async (trx) => {
    const order = await trx
      .selectFrom('store_orders')
      .select(['id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', orderId)
      .forUpdate()
      .executeTakeFirst();
    if (!order || !['paid', 'fulfilling'].includes(order.status))
      throw new StoreNotFoundError('Paid store order not found');
    const fulfillment = await trx
      .updateTable('store_fulfillments')
      .set({
        status: input.status,
        tracking_number: input.trackingNumber ?? null,
        fulfilled_by: ['shipped', 'picked_up'].includes(input.status)
          ? context.actor.accountId
          : null,
        fulfilled_at: ['shipped', 'picked_up'].includes(input.status)
          ? now
          : null,
        version: sql`version + 1`,
        updated_at: now,
      })
      .where('org_id', '=', context.orgId)
      .where('order_id', '=', orderId)
      .where('version', '=', input.expectedVersion)
      .returning(['order_id', 'method', 'status', 'tracking_number', 'version'])
      .executeTakeFirst();
    if (!fulfillment)
      throw new StoreConflictError('Fulfillment was updated by another user');
    await trx
      .updateTable('store_orders')
      .set({
        status:
          input.status === 'shipped' || input.status === 'picked_up'
            ? 'fulfilled'
            : 'fulfilling',
        updated_at: now,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', orderId)
      .execute();
    return {
      orderId: fulfillment.order_id,
      method: fulfillment.method,
      status: fulfillment.status,
      trackingNumber: fulfillment.tracking_number,
      version: fulfillment.version,
    };
  });
}

export async function listStoreOrders(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, async (trx) => {
    const rows = await trx
      .selectFrom('store_orders as store_order')
      .leftJoin('store_fulfillments as fulfillment', (join) =>
        join
          .onRef('fulfillment.org_id', '=', 'store_order.org_id')
          .onRef('fulfillment.order_id', '=', 'store_order.id'),
      )
      .leftJoin('accounts as account', (join) =>
        join.onRef('account.id', '=', 'store_order.account_id'),
      )
      .select([
        'store_order.id',
        'store_order.status',
        'store_order.invoice_id',
        'store_order.subtotal_cents',
        'store_order.tax_cents',
        'store_order.created_at',
        'store_order.shipping_address',
        'account.email as buyer_email',
        'fulfillment.method',
        'fulfillment.status as fulfillment_status',
        'fulfillment.tracking_number',
        'fulfillment.version as fulfillment_version',
      ])
      .where('store_order.org_id', '=', context.orgId)
      .orderBy('store_order.created_at', 'desc')
      .limit(200)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      invoiceId: row.invoice_id,
      subtotalCents: row.subtotal_cents,
      taxCents: row.tax_cents,
      createdAt: row.created_at.toISOString(),
      buyerEmail: row.buyer_email,
      shippingAddress: row.shipping_address,
      fulfillment: row.method
        ? {
            orderId: row.id,
            method: row.method,
            status: row.fulfillment_status,
            trackingNumber: row.tracking_number,
            version: row.fulfillment_version,
          }
        : null,
    }));
  });
}

export async function listMyStoreOrders(
  database: Kysely<DB>,
  context: OrgContext,
) {
  return createWithOrg(database)(context, async (trx) => {
    const rows = await trx
      .selectFrom('store_orders as store_order')
      .leftJoin('store_fulfillments as fulfillment', (join) =>
        join
          .onRef('fulfillment.org_id', '=', 'store_order.org_id')
          .onRef('fulfillment.order_id', '=', 'store_order.id'),
      )
      .select([
        'store_order.id',
        'store_order.status',
        'store_order.invoice_id',
        'store_order.subtotal_cents',
        'store_order.tax_cents',
        'fulfillment.method',
        'fulfillment.status as fulfillment_status',
        'fulfillment.tracking_number',
      ])
      .where('store_order.org_id', '=', context.orgId)
      .where('store_order.account_id', '=', context.actor.accountId)
      .orderBy('store_order.created_at', 'desc')
      .limit(100)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      invoiceId: row.invoice_id,
      subtotalCents: row.subtotal_cents,
      taxCents: row.tax_cents,
      fulfillment: row.method
        ? {
            method: row.method,
            status: row.fulfillment_status,
            trackingNumber: row.tracking_number,
          }
        : null,
    }));
  });
}

export async function runLowStockAlertJob(
  database: Kysely<DB>,
  now = new Date(),
): Promise<{ alerted: number }> {
  const alertType: string = 'store.low_stock';
  if (!isNotificationType(alertType)) return { alerted: 0 };
  const organizations = await database
    .selectFrom('organizations')
    .select('id')
    .where('status', '=', 'active')
    .execute();
  let alerted = 0;
  for (const organization of organizations) {
    const context: OrgContext = {
      orgId: organization.id,
      actor: { accountId: systemWorkerActorId },
    };
    alerted += await createWithOrg(database)(context, async (trx) => {
      const low = await sql<{
        id: string;
        product_name: string;
        sku: string;
        available: number;
      }>`
        SELECT variant.id, product.name AS product_name, variant.sku,
          COALESCE(balance.available, 0)::int AS available
        FROM product_variants variant
        JOIN products product ON product.org_id = variant.org_id AND product.id = variant.product_id AND product.active
        LEFT JOIN inventory_balances balance
          ON balance.org_id = variant.org_id AND balance.product_variant_id = variant.id
        WHERE variant.org_id = ${context.orgId}::uuid
          AND variant.archived_at IS NULL
          AND variant.low_stock_threshold IS NOT NULL
          AND variant.low_stock_notified_at IS NULL
          AND COALESCE(balance.available, 0) <= variant.low_stock_threshold
      `.execute(trx);
      if (!low.rows.length) return 0;
      const staff = await trx
        .selectFrom('role_assignments')
        .select('account_id')
        .where('org_id', '=', context.orgId)
        .where('role', 'in', ['owner', 'admin', 'finance', 'store_manager'])
        .where('scope_type', '=', 'org')
        .where('revoked_at', 'is', null)
        .where('pending_mfa', '=', false)
        .execute();
      for (const variant of low.rows) {
        for (const recipient of staff) {
          await createNotification(trx, context, {
            accountId: recipient.account_id,
            type: alertType,
            payload: {
              resourceType: 'product_variant',
              resourceId: variant.id,
              href: `/console/orgs/${context.orgId}/store`,
            },
          });
        }
        await trx
          .updateTable('product_variants')
          .set({ low_stock_notified_at: now })
          .where('org_id', '=', context.orgId)
          .where('id', '=', variant.id)
          .execute();
      }
      return low.rows.length;
    });
  }
  return { alerted };
}

export async function uniformSizeReport(
  database: Kysely<DB>,
  context: OrgContext,
  input: { teamSeasonId?: string; programId?: string },
) {
  return createWithOrg(database)(context, async (trx) => {
    const result = await sql<{
      team_season_id: string | null;
      name: string;
      size: string | null;
      quantity: number;
    }>`
      SELECT line.team_season_id, product.name, variant.size, sum(line.quantity)::int AS quantity
      FROM store_order_lines line JOIN store_orders store_order ON store_order.org_id = line.org_id AND store_order.id = line.order_id
      JOIN products product ON product.org_id = line.org_id AND product.id = line.product_id
      JOIN product_variants variant ON variant.org_id = line.org_id AND variant.id = line.product_variant_id
      LEFT JOIN registrations registration ON registration.org_id = line.org_id AND registration.id = line.registration_id
      WHERE line.org_id = ${context.orgId} AND product.kind = 'uniform' AND store_order.status IN ('paid', 'fulfilling', 'fulfilled')
        AND (${input.teamSeasonId ?? null}::uuid IS NULL OR line.team_season_id = ${input.teamSeasonId ?? null}::uuid)
        AND (${input.programId ?? null}::uuid IS NULL OR registration.program_id = ${input.programId ?? null}::uuid)
      GROUP BY line.team_season_id, product.name, variant.size ORDER BY product.name, variant.size`.execute(
      trx,
    );
    return result.rows.map((row) => ({
      teamSeasonId: row.team_season_id,
      productName: row.name,
      size: row.size,
      quantity: row.quantity,
    }));
  });
}
