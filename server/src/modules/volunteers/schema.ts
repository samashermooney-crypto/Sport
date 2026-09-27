import { z } from 'zod';

const uuid = z.uuid();
const date = z.iso.date();
const nonNegativeMoney = z.number().int().min(0).max(100_000_000);

export const volunteerRoleBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  minimumAge: z.number().int().min(0).max(120).default(18),
});

export const volunteerRequirementBodySchema = z
  .strictObject({
    seasonId: uuid.nullable().optional(),
    programId: uuid.nullable().optional(),
    unit: z.enum(['hours', 'shifts']),
    amountPerHousehold: z.number().positive().max(100_000).nullable().optional(),
    amountPerAthlete: z.number().positive().max(100_000).nullable().optional(),
    buyoutPriceCents: nonNegativeMoney.nullable().optional(),
    buyoutOfferingId: uuid.nullable().optional(),
    deadline: date,
    autoInvoiceShortfall: z.boolean().default(false),
    noticeDays: z.number().int().min(1).max(90).default(14),
    countsCoachRoles: z.boolean().default(false),
  })
  .refine((input) => Boolean(input.seasonId) !== Boolean(input.programId), {
    message: 'Choose one season or program scope',
  })
  .refine(
    (input) =>
      Boolean(input.amountPerHousehold) !== Boolean(input.amountPerAthlete),
    { message: 'Choose a household or athlete requirement' },
  );

export const volunteerShiftBodySchema = z
  .strictObject({
    requirementId: uuid.nullable().optional(),
    volunteerRoleId: uuid,
    eventId: uuid.nullable().optional(),
    facilityId: uuid,
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    slots: z.number().int().min(1).max(1000),
    creditHours: z.number().min(0).max(24).default(0),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((input) => new Date(input.startsAt) < new Date(input.endsAt), {
    message: 'Shift must end after it starts',
  });

export const volunteerSignupBodySchema = z.strictObject({
  personId: uuid,
  householdId: uuid,
});

export const volunteerStatusBodySchema = z.strictObject({
  status: z.enum(['confirmed', 'checked_in', 'completed', 'no_show', 'canceled']),
  hoursCredited: z.number().min(0).max(24).optional(),
  expectedVersion: z.number().int().positive(),
});

export const volunteerBuyoutBodySchema = z.strictObject({
  householdId: uuid,
  personId: uuid.nullable().optional(),
  units: z.number().positive().max(100_000),
});

export const volunteerRoleSchema = volunteerRoleBodySchema.extend({
  id: uuid,
  minimumAge: z.number().int().min(0).max(120),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
});

export const volunteerShiftSchema = z.strictObject({
  id: uuid,
  requirementId: uuid.nullable(),
  volunteerRoleId: uuid,
  roleName: z.string(),
  eventId: uuid.nullable(),
  facilityId: uuid,
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  slots: z.number().int().positive(),
  filledSlots: z.number().int().nonnegative(),
  creditHours: z.number().nonnegative(),
  notes: z.string().nullable(),
  status: z.enum(['open', 'closed', 'completed', 'canceled']),
  version: z.number().int().positive(),
});

export const volunteerSignupSchema = z.strictObject({
  id: uuid,
  volunteerShiftId: uuid,
  personId: uuid,
  householdId: uuid,
  status: z.enum(['signed_up', 'confirmed', 'checked_in', 'completed', 'no_show', 'canceled']),
  hoursCredited: z.number().nonnegative(),
  version: z.number().int().positive(),
});

export const volunteerLedgerSchema = z.strictObject({
  householdId: uuid,
  items: z.array(
    z.strictObject({
      requirementId: uuid,
      scopeId: uuid,
      scopeName: z.string(),
      unit: z.enum(['hours', 'shifts']),
      subjectPersonId: uuid.nullable(),
      required: z.number().nonnegative(),
      completed: z.number().nonnegative(),
      boughtOut: z.number().nonnegative(),
      remaining: z.number().nonnegative(),
      deadline: date,
      buyoutPriceCents: nonNegativeMoney.nullable(),
      buyoutAvailable: z.boolean(),
    }),
  ),
});

export const volunteerBuyoutResponseSchema = z.strictObject({
  id: uuid,
  invoiceId: uuid,
  amountCents: nonNegativeMoney,
  units: z.number().positive(),
});

export const volunteerRoleListSchema = z.strictObject({
  roles: z.array(volunteerRoleSchema),
});
export const volunteerShiftListSchema = z.strictObject({
  shifts: z.array(volunteerShiftSchema),
});
