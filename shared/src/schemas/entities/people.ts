import { z } from 'zod';

import {
  entityIdSchema,
  entityVersionSchema,
  tenantEntitySchema,
} from './base';

export const personEntitySchema = tenantEntitySchema.extend({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  preferredName: z.string().nullable(),
  dateOfBirth: z.iso.date(),
  gender: z.enum(['female', 'male', 'nonbinary', 'unspecified']),
  competitionGender: z.enum(['female', 'male', 'open']).nullable(),
  mediaConsent: z.enum(['granted', 'denied', 'unknown']),
  status: z.enum(['active', 'archived', 'merged', 'anonymized']),
  version: entityVersionSchema,
});

export const householdEntitySchema = tenantEntitySchema.extend({
  name: z.string().min(1),
  status: z.enum(['active', 'archived']),
  version: entityVersionSchema,
});

export const householdMemberEntitySchema = tenantEntitySchema.extend({
  householdId: entityIdSchema,
  personId: entityIdSchema,
  role: z.enum(['guardian', 'athlete', 'other_adult', 'other_child']),
  isPrimaryContact: z.boolean(),
  financiallyResponsible: z.boolean(),
  canPickUp: z.boolean(),
});
