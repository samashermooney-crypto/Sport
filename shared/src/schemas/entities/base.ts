import { z } from 'zod';

export const entityIdSchema = z.uuid();
export const moneyCentsSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger);
export const signedMoneyCentsSchema = z
  .number()
  .int()
  .refine(Number.isSafeInteger);
export const entityVersionSchema = z.number().int().positive();

export const tenantEntitySchema = z.strictObject({
  id: entityIdSchema,
  orgId: entityIdSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
