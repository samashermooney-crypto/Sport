import { z } from 'zod';

const medicalDetailsSchema = z.strictObject({
  allergies: z.string().trim().max(4000).nullable(),
  allergyFlags: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).max(30),
  conditions: z.string().trim().max(4000).nullable(),
  medications: z.string().trim().max(4000).nullable(),
  physicianName: z.string().trim().max(200).nullable(),
  physicianPhone: z.string().trim().max(50).nullable(),
  insuranceCarrier: z.string().trim().max(200).nullable(),
  insurancePolicy: z.string().trim().max(200).nullable(),
  notes: z.string().trim().max(4000).nullable(),
});

export const medicalUpdateSchema = medicalDetailsSchema.extend({
  expectedVersion: z.int().nonnegative(),
});

export const medicalResponseSchema = medicalDetailsSchema.extend({
  personId: z.uuid(),
  version: z.int().nonnegative(),
  visibility: z.enum(['full', 'flags_only']),
  canEdit: z.boolean(),
  onFile: z.boolean(),
});

export type MedicalUpdate = z.output<typeof medicalUpdateSchema>;
