import { newId } from '@shared/ids';
import { percentOf } from '@shared/money';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';
import { PostgresInvoiceRepository } from '../finance/invoice-repo';
import { systemWorkerActorId } from '../jobs/credentials-expiry';
import { isNotificationType } from '../notifications/catalog';
import { createNotification } from '../notifications/service';

export class StoreConflictError extends Error {
  readonly status = 409;
  readonly code = 'CONFLICT';
}
export class StoreNotFoundError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
}
export class StoreAccessError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
}

export async function createProduct(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    name: string;
    description?: string | null | undefined;
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
    const productId = newId();
    await trx
      .insertInto('products')
      .values({
        id: productId,
        org_id: context.orgId,
        category_id: null,
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
      kind: 'uniform' | 'spirit_wear' | 'other';
      required_for_registration: boolean;
      active: boolean;
      variant_id: string | null;
      sku: string | null;
      size: string | null;
      color: string | null;
      price_cents: number | null;
      tax_rate_id: string | null;
      on_hand: number | null;
      reserved: number | null;
      available: number | null;
      low_stock_threshold: number | null;
    }>`SELECT product.id, product.name, product.description, product.kind, product.required_for_registration, product.active,
       variant.id AS variant_id, variant.sku, variant.size, variant.color, variant.price_cents, variant.tax_rate_id, variant.low_stock_threshold,
       COALESCE(balance.on_hand, 0)::int AS on_hand, COALESCE(balance.reserved, 0)::int AS reserved, COALESCE(balance.available, 0)::int AS available
      FROM products product LEFT JOIN product_variants variant ON variant.org_id = product.org_id AND variant.product_id = product.id AND variant.archived_at IS NULL
      LEFT JOIN inventory_balances balance ON balance.org_id = variant.org_id AND balance.product_variant_id = variant.id
      WHERE product.org_id = ${context.orgId} AND product.active = true ORDER BY product.name, variant.sku`.execute(
      trx,
    );
    const products = new Map<
      string,
      {
        id: string;
        name: string;
        description: string | null;
        kind: 'uniform' | 'spirit_wear' | 'other';
        requiredForRegistration: boolean;
        active: boolean;
        variants: unknown[];
      }
    >();
    for (const row of result.rows) {
      let product = products.get(row.id);
      if (!product) {
        product = {
          id: row.id,
          name: row.name,
          description: row.description,
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
  const existing = await withOrg(context, (trx) =>
    trx
      .selectFrom('store_orders')
      .select(['id', 'invoice_id', 'subtotal_cents', 'tax_cents', 'status'])
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst(),
  );
  if (existing)
    return {
      id: existing.id,
      invoiceId: existing.invoice_id,
      subtotalCents: existing.subtotal_cents,
      taxCents: existing.tax_cents,
      status: existing.status,
    };
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
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('id', '=', input.registrationId)
          .where('household_id', '=', input.householdId ?? null)
          .where('status', 'in', ['confirmed', 'pending_payment'])
          .executeTakeFirst();
        if (!registration)
          throw new StoreNotFoundError(
            'Registration not found for this household',
          );
      }
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
            registration_id: input.registrationId ?? null,
            person_id: requested.personId ?? null,
            team_season_id: input.teamSeasonId ?? null,
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
          teamSeasonId: input.teamSeasonId ?? null,
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
        .insertInto('store_orders')
        .values({
          id: orderId,
          org_id: context.orgId,
          account_id: context.actor.accountId,
          household_id: input.householdId ?? null,
          registration_id: input.registrationId ?? null,
          team_season_id: input.teamSeasonId ?? null,
          status: 'awaiting_payment',
          subtotal_cents: subtotalCents,
          tax_cents: taxCents,
          invoice_id: null,
          idempotency_key: input.idempotencyKey,
        })
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
      SELECT order.id AS order_id, line.id AS line_id, line.product_variant_id AS variant_id, line.quantity
      FROM store_orders order JOIN invoices invoice ON invoice.org_id = order.org_id AND invoice.id = order.invoice_id
      JOIN store_order_lines line ON line.org_id = order.org_id AND line.order_id = order.id
      WHERE order.org_id = ${context.orgId} AND order.status = 'awaiting_payment' AND invoice.status = 'paid'
      ORDER BY order.created_at FOR UPDATE OF order SKIP LOCKED`.execute(trx);
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
      .selectFrom('store_orders as order')
      .leftJoin('store_fulfillments as fulfillment', (join) =>
        join
          .onRef('fulfillment.org_id', '=', 'order.org_id')
          .onRef('fulfillment.order_id', '=', 'order.id'),
      )
      .leftJoin('accounts as account', (join) =>
        join.on('account.id', '=', 'order.account_id'),
      )
      .select([
        'order.id',
        'order.status',
        'order.invoice_id',
        'order.subtotal_cents',
        'order.tax_cents',
        'order.created_at',
        'account.email as buyer_email',
        'fulfillment.method',
        'fulfillment.status as fulfillment_status',
        'fulfillment.tracking_number',
        'fulfillment.version as fulfillment_version',
      ])
      .where('order.org_id', '=', context.orgId)
      .orderBy('order.created_at', 'desc')
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
      fulfillment: row.method
        ? {
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
      .selectFrom('store_orders as order')
      .leftJoin('store_fulfillments as fulfillment', (join) =>
        join
          .onRef('fulfillment.org_id', '=', 'order.org_id')
          .onRef('fulfillment.order_id', '=', 'order.id'),
      )
      .select([
        'order.id',
        'order.status',
        'order.invoice_id',
        'order.subtotal_cents',
        'order.tax_cents',
        'fulfillment.method',
        'fulfillment.status as fulfillment_status',
        'fulfillment.tracking_number',
      ])
      .where('order.org_id', '=', context.orgId)
      .where('order.account_id', '=', context.actor.accountId)
      .orderBy('order.created_at', 'desc')
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
      FROM store_order_lines line JOIN store_orders order ON order.org_id = line.org_id AND order.id = line.order_id
      JOIN products product ON product.org_id = line.org_id AND product.id = line.product_id
      JOIN product_variants variant ON variant.org_id = line.org_id AND variant.id = line.product_variant_id
      LEFT JOIN registrations registration ON registration.org_id = line.org_id AND registration.id = line.registration_id
      WHERE line.org_id = ${context.orgId} AND product.kind = 'uniform' AND order.status IN ('paid', 'fulfilling', 'fulfilled')
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
