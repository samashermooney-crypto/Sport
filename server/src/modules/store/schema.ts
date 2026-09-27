import { z } from 'zod';

const uuid = z.uuid();
const cents = z.number().int().min(0).max(100_000_000);

export const productBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).nullable().optional(),
  categoryId: uuid.nullable().optional(),
  kind: z.enum(['uniform', 'spirit_wear', 'other']),
  requiredForRegistration: z.boolean().default(false),
  variants: z
    .array(
      z.strictObject({
        sku: z.string().trim().min(1).max(80),
        size: z.string().trim().max(40).nullable().optional(),
        color: z.string().trim().max(80).nullable().optional(),
        priceCents: cents,
        taxRateId: uuid.nullable().optional(),
        lowStockThreshold: z
          .number()
          .int()
          .min(0)
          .max(100_000)
          .nullable()
          .optional(),
      }),
    )
    .min(1)
    .max(100),
});
export const productSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  categoryId: uuid.nullable(),
  categoryName: z.string().nullable(),
  kind: z.enum(['uniform', 'spirit_wear', 'other']),
  requiredForRegistration: z.boolean(),
  active: z.boolean(),
  variants: z.array(
    z.strictObject({
      id: uuid,
      sku: z.string(),
      size: z.string().nullable(),
      color: z.string().nullable(),
      priceCents: cents,
      taxRateId: uuid.nullable(),
      onHand: z.number().int(),
      reserved: z.number().int(),
      available: z.number().int(),
      lowStockThreshold: z.number().int().nullable(),
    }),
  ),
});
export const productListSchema = z.strictObject({
  products: z.array(productSchema),
});
export const productCategorySchema = z.strictObject({
  id: uuid,
  name: z.string(),
  sortOrder: z.number().int(),
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  version: z.number().int().positive(),
});
export const productCategoryListSchema = z.strictObject({
  categories: z.array(productCategorySchema),
});
export const productCategoryBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  sortOrder: z.number().int().min(-100_000).max(100_000).optional(),
});
export const productCategoryUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  sortOrder: z.number().int().min(-100_000).max(100_000).optional(),
  archived: z.boolean().optional(),
  expectedVersion: z.number().int().positive(),
});
export const registrationAddOnBodySchema = z.strictObject({
  productId: uuid,
  required: z.boolean(),
  quantity: z.number().int().min(1).max(100),
  active: z.boolean().default(true),
  expectedVersion: z.number().int().positive().optional(),
});
export const registrationAddOnSchema = z.strictObject({
  id: uuid,
  productId: uuid,
  productName: z.string(),
  kind: z.enum(['uniform', 'spirit_wear', 'other']),
  required: z.boolean(),
  quantity: z.number().int().positive(),
  version: z.number().int().positive(),
  variants: z.array(
    z.strictObject({
      id: uuid,
      sku: z.string(),
      size: z.string().nullable(),
      color: z.string().nullable(),
      priceCents: cents,
      available: z.number().int().nonnegative(),
    }),
  ),
});
export const registrationAddOnListSchema = z.strictObject({
  addons: z.array(registrationAddOnSchema),
});
export const stockBodySchema = z.strictObject({
  quantity: z.number().int().min(1).max(10000),
  memo: z.string().trim().max(500).optional(),
});
export const shippingAddressSchema = z.strictObject({
  line1: z.string().trim().min(1).max(160),
  line2: z.string().trim().max(160).optional(),
  city: z.string().trim().min(1).max(100),
  region: z
    .string()
    .trim()
    .length(2)
    .regex(/^[A-Z]{2}$/),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}(?:-\d{4})?$/),
  country: z.literal('US'),
});
export const orderBodySchema = z.strictObject({
  householdId: uuid.nullable().optional(),
  registrationId: uuid.nullable().optional(),
  teamSeasonId: uuid.nullable().optional(),
  fulfillmentMethod: z.enum(['pickup', 'ship']),
  shippingAddress: shippingAddressSchema.optional(),
  lines: z
    .array(
      z.strictObject({
        variantId: uuid,
        quantity: z.number().int().min(1).max(100),
        personId: uuid.nullable().optional(),
      }),
    )
    .min(1)
    .max(30),
  idempotencyKey: uuid,
});
export const orderSchema = z.strictObject({
  id: uuid,
  status: z.enum([
    'draft',
    'awaiting_payment',
    'paid',
    'fulfilling',
    'fulfilled',
    'canceled',
    'refunded',
  ]),
  invoiceId: uuid.nullable(),
  subtotalCents: cents,
  taxCents: cents,
});
export const fulfillmentBodySchema = z.strictObject({
  status: z.enum(['ready', 'shipped', 'picked_up', 'canceled']),
  trackingNumber: z.string().trim().max(120).nullable().optional(),
  expectedVersion: z.number().int().positive(),
});
export const fulfillmentSchema = z.strictObject({
  orderId: uuid,
  method: z.enum(['pickup', 'ship']),
  status: z.enum(['pending', 'ready', 'shipped', 'picked_up', 'canceled']),
  trackingNumber: z.string().nullable(),
  version: z.number().int().positive(),
});
export const uniformReportSchema = z.strictObject({
  rows: z.array(
    z.strictObject({
      teamSeasonId: uuid.nullable(),
      productName: z.string(),
      size: z.string().nullable(),
      quantity: z.number().int().nonnegative(),
    }),
  ),
});
export const adminOrderListSchema = z.strictObject({
  orders: z.array(
    orderSchema.extend({
      createdAt: z.iso.datetime({ offset: true }),
      buyerEmail: z.string().nullable(),
      shippingAddress: shippingAddressSchema.nullable(),
      fulfillment: fulfillmentSchema.nullable(),
    }),
  ),
});
