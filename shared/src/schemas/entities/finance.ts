import { z } from 'zod';

import {
  entityIdSchema,
  entityVersionSchema,
  moneyCentsSchema,
  signedMoneyCentsSchema,
  tenantEntitySchema,
} from './base';

export const invoiceEntitySchema = tenantEntitySchema.extend({
  number: z.number().int().positive(),
  accountId: entityIdSchema,
  status: z.enum([
    'draft',
    'open',
    'paid',
    'partially_paid',
    'past_due',
    'void',
    'uncollectible',
  ]),
  currency: z.literal('USD'),
  totalCents: moneyCentsSchema,
  paidCents: moneyCentsSchema,
  refundedCents: moneyCentsSchema,
  creditAppliedCents: moneyCentsSchema,
  balanceCents: moneyCentsSchema,
  version: entityVersionSchema,
});

export const invoiceLineEntitySchema = tenantEntitySchema.extend({
  invoiceId: entityIdSchema,
  kind: z.enum([
    'registration',
    'add_on',
    'product',
    'team_fee',
    'tuition',
    'volunteer_buyout',
    'donation',
    'service_fee',
    'late_fee',
    'adjustment',
    'discount',
    'aid',
  ]),
  description: z.string().min(1),
  quantity: z.number().int().positive(),
  unitAmountCents: signedMoneyCentsSchema,
  amountCents: signedMoneyCentsSchema,
});

export const paymentEntitySchema = tenantEntitySchema.extend({
  method: z.enum([
    'card',
    'us_bank_account',
    'link',
    'apple_pay',
    'google_pay',
    'cash',
    'check',
    'external',
  ]),
  status: z.enum([
    'requires_action',
    'processing',
    'succeeded',
    'failed',
    'canceled',
  ]),
  amountCents: moneyCentsSchema.positive(),
  applicationFeeCents: moneyCentsSchema,
  processingFeeCents: moneyCentsSchema,
  netCents: signedMoneyCentsSchema,
  version: entityVersionSchema,
});

export const refundEntitySchema = tenantEntitySchema.extend({
  paymentId: entityIdSchema,
  amountCents: moneyCentsSchema.positive(),
  reason: z.enum([
    'requested_by_customer',
    'duplicate',
    'fraudulent',
    'program_canceled',
    'withdrawal_policy',
    'other',
  ]),
  status: z.enum(['pending', 'succeeded', 'failed', 'canceled']),
  version: entityVersionSchema,
});
