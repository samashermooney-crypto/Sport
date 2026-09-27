import { z } from 'zod';

import { notificationTypes } from './catalog';

const notificationTypeSchema = z.enum(notificationTypes);
export const notificationPayloadSchema = z.strictObject({
  resourceType: z.string().min(1).max(80).optional(),
  resourceId: z.uuid().optional(),
  href: z
    .string()
    .max(500)
    .regex(/^\/(?!\/)[A-Za-z0-9/_?=&%#.-]*$/)
    .optional(),
});
export const notificationSchema = z.strictObject({
  id: z.uuid(),
  orgId: z.uuid(),
  type: notificationTypeSchema,
  title: z.string(),
  payload: notificationPayloadSchema,
  readAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export const inboxPageSchema = z.strictObject({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
});
export const preferenceSchema = z.strictObject({
  category: z.enum(['operational', 'announcement', 'marketing', 'emergency']),
  channel: z.enum(['in_app', 'email']),
  enabled: z.boolean(),
  version: z.number().int().nonnegative(),
});
export const preferencesSchema = z.strictObject({
  items: z.array(preferenceSchema),
});
export const updatePreferenceSchema = z.strictObject({
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
});
export const markReadSchema = z.strictObject({
  readAt: z.iso.datetime({ offset: true }),
});
