import { z } from 'zod';

const householdAddressSchema = z.strictObject({
  street: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).default(''),
  postalCode: z.string().trim().max(32).default(''),
  country: z.string().trim().length(2).default('US'),
});

export const householdCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  address: householdAddressSchema.nullable().default(null),
});

export const householdUpdateSchema = z.strictObject({
  expectedVersion: z.int().positive(),
  name: z.string().trim().min(1).max(160).optional(),
  address: householdAddressSchema.nullable().optional(),
});

export const householdMemberCreateSchema = z.strictObject({
  personId: z.uuid(),
  role: z.enum(['guardian', 'athlete', 'other_adult', 'other_child']),
  isPrimaryContact: z.boolean().default(false),
  receivesCommunications: z.boolean().default(false),
  financiallyResponsible: z.boolean().default(false),
  canPickUp: z.boolean().default(false),
  livesHere: z.boolean().default(true),
});

export const householdMemberUpdateSchema = householdMemberCreateSchema
  .omit({ personId: true })
  .partial()
  .extend({ expectedVersion: z.int().positive() });

export const householdMemberRemoveSchema = z.strictObject({
  expectedVersion: z.int().positive(),
});

const householdMemberResponseSchema = z.strictObject({
  id: z.uuid(),
  personId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  role: householdMemberCreateSchema.shape.role,
  isPrimaryContact: z.boolean(),
  receivesCommunications: z.boolean(),
  financiallyResponsible: z.boolean(),
  canPickUp: z.boolean(),
  livesHere: z.boolean(),
});

export const householdResponseSchema = z.strictObject({
  id: z.uuid(),
  orgId: z.uuid(),
  name: z.string(),
  address: householdAddressSchema.nullable(),
  status: z.enum(['active', 'archived']),
  version: z.int().positive(),
  balances: z.array(
    z.strictObject({ currency: z.string().length(3), amountCents: z.int() }),
  ),
  members: z.array(householdMemberResponseSchema),
  registrations: z.array(
    z.strictObject({
      id: z.uuid(),
      personId: z.uuid(),
      programId: z.uuid(),
      status: z.string(),
    }),
  ),
});

export const householdListSchema = z.strictObject({
  items: z.array(householdResponseSchema),
  nextCursor: z.uuid().nullable(),
});

export const householdsQuerySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  cursor: z.uuid().optional(),
});
