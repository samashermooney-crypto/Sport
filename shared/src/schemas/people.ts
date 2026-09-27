import { z } from 'zod';

const editablePersonSchema = z.strictObject({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  preferredName: z.string().trim().max(120).nullable(),
  dateOfBirth: z.iso.date(),
  graduationYear: z.int().min(1900).max(2200).nullable(),
  gender: z.enum(['female', 'male', 'nonbinary', 'unspecified']),
  email: z.email().nullable(),
  phoneE164: z
    .string()
    .regex(/^\+[1-9][0-9]{1,14}$/)
    .nullable(),
  mediaConsent: z.enum(['granted', 'denied', 'unknown']),
});

export const personCreateSchema = editablePersonSchema.extend({
  graduationYear: editablePersonSchema.shape.graduationYear.default(null),
  preferredName: editablePersonSchema.shape.preferredName.default(null),
  gender: editablePersonSchema.shape.gender.default('unspecified'),
  email: editablePersonSchema.shape.email.default(null),
  phoneE164: editablePersonSchema.shape.phoneE164.default(null),
  mediaConsent: editablePersonSchema.shape.mediaConsent.default('unknown'),
});

export const personUpdateSchema = editablePersonSchema.partial().extend({
  expectedVersion: z.int().positive(),
});

export const personResponseSchema = z.strictObject({
  id: z.uuid(),
  orgId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  preferredName: z.string().nullable(),
  dateOfBirth: z.iso.date(),
  graduationYear: z.int().min(1900).max(2200).nullable(),
  age: z.int().nonnegative(),
  grade: z.string().nullable(),
  gender: z.enum(['female', 'male', 'nonbinary', 'unspecified']),
  email: z.string().nullable(),
  phoneE164: z.string().nullable(),
  mediaConsent: z.enum(['granted', 'denied', 'unknown']),
  status: z.enum(['active', 'archived', 'merged', 'anonymized']),
  version: z.int().positive(),
});

export const peopleListSchema = z.strictObject({
  items: z.array(personResponseSchema),
  nextCursor: z.uuid().nullable(),
});

export const peopleQuerySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  status: z
    .enum(['active', 'archived', 'merged', 'anonymized'])
    .default('active'),
  gender: z.enum(['female', 'male', 'nonbinary', 'unspecified']).optional(),
  minAge: z.coerce.number().int().min(0).max(120).optional(),
  maxAge: z.coerce.number().int().min(0).max(120).optional(),
  grade: z.coerce.number().int().min(-1).max(12).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
