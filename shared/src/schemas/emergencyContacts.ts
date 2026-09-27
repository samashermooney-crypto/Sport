import { z } from 'zod';

const fields = z.strictObject({
  name: z.string().trim().min(1).max(200),
  relationship: z.string().trim().min(1).max(100),
  phoneE164: z.string().regex(/^\+[1-9][0-9]{1,14}$/),
  altPhoneE164: z
    .string()
    .regex(/^\+[1-9][0-9]{1,14}$/)
    .nullable(),
  priority: z.int().min(1).max(99),
});

export const emergencyContactCreateSchema = fields;
export const emergencyContactUpdateSchema = fields.partial().extend({
  expectedVersion: z.int().positive(),
});
export const emergencyContactRemoveSchema = z.strictObject({
  expectedVersion: z.int().positive(),
});
export const emergencyContactSchema = fields.extend({
  id: z.uuid(),
  version: z.int().positive(),
});
export const emergencyContactsSchema = z.strictObject({
  items: z.array(emergencyContactSchema),
  canEdit: z.boolean(),
});
