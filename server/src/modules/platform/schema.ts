import { z } from 'zod';

const orgSummarySchema = z.strictObject({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  kind: z.string(),
  status: z.string(),
  version: z.number().int().positive(),
  planName: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export const orgPageSchema = z.strictObject({
  items: z.array(orgSummarySchema),
  nextCursor: z.string().nullable(),
});
export const orgDetailSchema = orgSummarySchema
  .omit({ planName: true })
  .extend({
    planId: z.uuid().nullable(),
    planName: z.string().nullable(),
    applicationFeeBps: z.number().int(),
    applicationFeeFixedCents: z.number().int(),
    stripe: z
      .strictObject({
        onboardingStatus: z.string(),
        chargesEnabled: z.boolean(),
        payoutsEnabled: z.boolean(),
        detailsSubmitted: z.boolean(),
      })
      .nullable(),
  });
export const statusInputSchema = z.strictObject({
  status: z.enum(['active', 'suspended']),
  expectedVersion: z.number().int().positive(),
});
export const statusResultSchema = z.strictObject({
  status: z.enum(['active', 'suspended']),
  version: z.number().int().positive(),
});
export const planAssignmentSchema = z.strictObject({
  planId: z.uuid(),
  expectedVersion: z.number().int().positive(),
});
export const planAssignmentResultSchema = z.strictObject({
  planId: z.uuid(),
  version: z.number().int().positive(),
});
const planSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  monthlyPriceCents: z.number().int(),
  applicationFeeBps: z.number().int(),
  applicationFeeFixedCents: z.number().int(),
  limits: z.unknown(),
  active: z.boolean(),
  version: z.number().int(),
});
export const plansSchema = z.strictObject({ items: z.array(planSchema) });
export const saveResultSchema = z.strictObject({
  id: z.uuid(),
  version: z.number().int(),
});
const featureFlagSchema = z.strictObject({
  key: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  organizationOverrides: z.record(z.uuid(), z.boolean()),
  version: z.number().int(),
});
export const featureFlagsSchema = z.strictObject({
  items: z.array(featureFlagSchema),
});
export const featureFlagResultSchema = z.strictObject({
  key: z.string(),
  version: z.number().int(),
});
const staffSchema = z.strictObject({
  accountId: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: z.enum(['super_admin', 'support', 'finance_ops']),
  active: z.boolean(),
});
export const platformMeSchema = z.strictObject({
  accountId: z.uuid(),
  role: z.enum(['super_admin', 'support', 'finance_ops']),
});
export const staffListSchema = z.strictObject({ items: z.array(staffSchema) });
export const staffInputSchema = z.strictObject({
  role: z.enum(['super_admin', 'support', 'finance_ops']),
  active: z.boolean(),
});
export const staffResultSchema = staffInputSchema.extend({
  accountId: z.uuid(),
});
export const impersonationInputSchema = z.strictObject({
  organizationId: z.uuid(),
  reason: z.string().trim().min(10).max(500),
});
export const impersonationSchema = z.strictObject({
  id: z.uuid(),
  organizationId: z.uuid(),
  reason: z.string(),
  readOnly: z.literal(true),
  expiresAt: z.iso.datetime({ offset: true }),
});
export const okSchema = z.strictObject({ ok: z.literal(true) });
export const healthSchema = z.strictObject({
  queues: z.array(
    z.strictObject({
      name: z.string(),
      pending: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
  ),
  failedJobs: z.array(
    z.strictObject({
      id: z.uuid(),
      queue: z.string(),
      createdAt: z.iso.datetime({ offset: true }),
    }),
  ),
  workerHeartbeatAt: z.iso.datetime({ offset: true }).nullable(),
  lastStripeWebhookReceivedAt: z.iso.datetime({ offset: true }).nullable(),
  lastStripeWebhookProcessedAt: z.iso.datetime({ offset: true }).nullable(),
});
