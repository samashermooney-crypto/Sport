import { recurrenceSchema } from '@shared/recurrence';
import { z } from 'zod';

const uuid = z.uuid();
const tuitionTier = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  name: z.string().trim().min(1).max(100),
  classesPerWeek: z.number().int().min(1).max(14),
  amountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  siblingDiscountBps: z.number().int().min(0).max(10000).default(0),
});

export const classOfferingSchema = z.strictObject({
  name: z.string().trim().min(1).max(140),
  level: z.string().trim().min(1).max(80),
  minimumAgeMonths: z.number().int().min(0).max(240),
  maximumAgeMonths: z.number().int().min(0).max(240),
  capacity: z.number().int().min(1).max(500),
  instructorRatio: z.number().int().min(1).max(100),
  billingTerm: z.enum(['monthly', 'drop_in', 'punch_card']),
  tuitionTiers: z.array(tuitionTier).min(1).max(20),
  trialAllowed: z.boolean().default(false),
  makeupCreditsPerTerm: z.number().int().min(0).max(30).default(0),
  makeupExpiresAfterDays: z.number().int().min(1).max(730).default(90),
  makeupEligible: z.boolean().default(true),
  prorationSetting: z.enum(['session_count', 'full_month', 'no_charge_after_20th']).default('session_count'),
  recurrence: recurrenceSchema.nullable().default(null),
  active: z.boolean().default(false),
}).refine((value) => value.maximumAgeMonths >= value.minimumAgeMonths, { message: 'Maximum age must not be below minimum age' })
  .refine((value) => new Set(value.tuitionTiers.map((tier) => tier.key)).size === value.tuitionTiers.length, { message: 'Tuition tier keys must be unique' });

export const classScheduleSchema = z.strictObject({
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),
  durationMinutes: z.number().int().min(10).max(240),
  timezone: z.string().trim().min(1).max(100),
  recurrence: recurrenceSchema,
  facilityId: uuid.nullable().default(null),
});

export const classEnrollmentSchema = z.strictObject({
  personId: uuid,
  householdId: uuid,
  tuitionTierKey: z.string().trim().min(1).max(40),
  trial: z.boolean().default(false),
});

export const classAttendanceSchema = z.strictObject({
  enrollmentId: uuid,
  status: z.enum(['present', 'absent', 'late', 'excused']),
  checkedInAt: z.iso.datetime().nullable().default(null),
  checkedOutAt: z.iso.datetime().nullable().default(null),
  pickupAccountId: uuid.nullable().default(null),
});

export const makeupBookingSchema = z.strictObject({
  creditId: uuid,
  sessionId: uuid,
});

export const skillUpdateSchema = z.strictObject({
  enrollmentId: uuid,
  skillDefinitionId: uuid,
  proficiency: z.enum(['not_started', 'learning', 'achieved', 'mastered']),
  notes: z.string().trim().max(4000).nullable().default(null),
});

export const levelRecommendationSchema = z.strictObject({
  enrollmentId: uuid,
  nextOfferingId: uuid,
});

export const guardianPromotionDecisionSchema = z.strictObject({
  decision: z.enum(['confirm', 'decline']),
  expectedVersion: z.number().int().positive(),
});

export type ClassOfferingInput = z.infer<typeof classOfferingSchema>;
export type ClassScheduleInput = z.infer<typeof classScheduleSchema>;
