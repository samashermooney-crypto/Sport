import { z } from 'zod';

import { recurrenceSchema } from '../recurrence';

import {
  entityIdSchema,
  entityVersionSchema,
  moneyCentsSchema,
  tenantEntitySchema,
} from './entities/base';

export const classBillingSchema = z.enum([
  'term',
  'monthly',
  'drop_in',
  'punch_card',
]);
export type ClassBilling = z.infer<typeof classBillingSchema>;

export const tuitionTierSchema = z.strictObject({
  maxClassesPerWeek: z.number().int().positive().nullable(),
  amountCents: moneyCentsSchema,
});
export const tuitionTiersSchema = z
  .array(tuitionTierSchema)
  .max(12)
  .superRefine((tiers, ctx) => {
    const unlimited = tiers.filter((tier) => tier.maxClassesPerWeek === null);
    if (unlimited.length > 1)
      ctx.addIssue({ code: 'custom', message: 'One open-ended tier maximum' });
    const seen = new Set<number>();
    for (const tier of tiers) {
      if (tier.maxClassesPerWeek !== null) {
        if (seen.has(tier.maxClassesPerWeek))
          ctx.addIssue({
            code: 'custom',
            message: 'Duplicate classes-per-week tier bound',
          });
        seen.add(tier.maxClassesPerWeek);
      }
    }
  });
export type TuitionTier = z.infer<typeof tuitionTierSchema>;

export const makeupPolicySchema = z.strictObject({
  creditsPerTerm: z.number().int().nonnegative().default(0),
  expiryDays: z.number().int().positive().default(90),
  eligibleLevelIds: z.array(entityIdSchema).nullable().default(null),
  eligibleOfferingIds: z.array(entityIdSchema).nullable().default(null),
});
export type MakeupPolicy = z.infer<typeof makeupPolicySchema>;

export const classOfferingSchema = tenantEntitySchema.extend({
  programId: entityIdSchema,
  skillLevelId: entityIdSchema.nullable(),
  name: z.string().min(1),
  description: z.string().nullable(),
  ageMinMonths: z.number().int().nonnegative().nullable(),
  ageMaxMonths: z.number().int().nonnegative().nullable(),
  capacity: z.number().int().positive(),
  instructorRatio: z.number().positive(),
  billing: classBillingSchema,
  priceCents: moneyCentsSchema,
  punchCardUses: z.number().int().positive().nullable(),
  tuitionTiers: tuitionTiersSchema,
  annualFeeCents: moneyCentsSchema,
  trialAllowed: z.boolean(),
  trialPriceCents: moneyCentsSchema,
  makeupPolicy: makeupPolicySchema,
  siblingDiscountBps: z.array(z.number().int().min(0).max(10_000)),
  status: z.enum(['draft', 'active', 'archived']),
  enrolledCount: z.number().int().nonnegative(),
  spotsRemaining: z.number().int().nullable(),
  levelName: z.string().nullable(),
  programName: z.string().nullable(),
  version: entityVersionSchema,
});
export type ClassOffering = z.infer<typeof classOfferingSchema>;

export const classOfferingBodySchema = z.strictObject({
  programId: entityIdSchema,
  skillLevelId: entityIdSchema.nullable().default(null),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000).nullable().default(null),
  ageMinMonths: z.number().int().min(0).max(1200).nullable().default(null),
  ageMaxMonths: z.number().int().min(0).max(1200).nullable().default(null),
  capacity: z.number().int().min(1).max(500),
  instructorRatio: z.number().min(0.25).max(500),
  billing: classBillingSchema,
  priceCents: moneyCentsSchema,
  punchCardUses: z.number().int().positive().max(100).nullable().default(null),
  tuitionTiers: tuitionTiersSchema.default([]),
  annualFeeCents: moneyCentsSchema.default(0),
  trialAllowed: z.boolean().default(false),
  trialPriceCents: moneyCentsSchema.default(0),
  makeupPolicy: makeupPolicySchema.default({
    creditsPerTerm: 0,
    expiryDays: 90,
    eligibleLevelIds: null,
    eligibleOfferingIds: null,
  }),
  siblingDiscountBps: z
    .array(z.number().int().min(0).max(10_000))
    .max(10)
    .default([]),
  status: z.enum(['draft', 'active']).default('active'),
});
export type ClassOfferingBody = z.output<typeof classOfferingBodySchema>;

export const classOfferingUpdateSchema = classOfferingBodySchema
  .omit({ programId: true })
  .partial()
  .extend({ expectedVersion: entityVersionSchema });
export type ClassOfferingUpdate = z.output<typeof classOfferingUpdateSchema>;

export const classOfferingListSchema = z.strictObject({
  items: z.array(classOfferingSchema),
  nextCursor: z.string().nullable(),
});

export const classScheduleSchema = tenantEntitySchema.extend({
  classOfferingId: entityIdSchema,
  recurrence: recurrenceSchema,
  startTime: z.string(),
  durationMinutes: z.number().int().positive(),
  timezone: z.string(),
  spaceId: entityIdSchema.nullable(),
  locationText: z.string().nullable(),
  spaceName: z.string().nullable(),
  termStart: z.iso.date(),
  termEnd: z.iso.date(),
  status: z.enum(['active', 'ended', 'canceled']),
  instructors: z.array(
    z.strictObject({
      personId: entityIdSchema,
      name: z.string(),
      status: z.enum(['pending_compliance', 'active', 'removed']),
    }),
  ),
  sessionCount: z.number().int().nonnegative(),
  version: entityVersionSchema,
});
export type ClassSchedule = z.infer<typeof classScheduleSchema>;

export const classScheduleBodySchema = z.strictObject({
  recurrence: recurrenceSchema,
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  timezone: z.string().min(1).max(64),
  spaceId: entityIdSchema.nullable().default(null),
  locationText: z.string().max(240).nullable().default(null),
  termStart: z.iso.date(),
  termEnd: z.iso.date(),
});
export type ClassScheduleBody = z.output<typeof classScheduleBodySchema>;

export const classScheduleUpdateSchema = classScheduleBodySchema
  .partial()
  .extend({
    expectedVersion: entityVersionSchema,
    regenerate: z.boolean().default(false),
  });
export type ClassScheduleUpdate = z.output<typeof classScheduleUpdateSchema>;

export const instructorAssignSchema = z.strictObject({
  personId: entityIdSchema,
});
export const instructorSchema = z.strictObject({
  id: entityIdSchema,
  personId: entityIdSchema,
  name: z.string(),
  status: z.enum(['pending_compliance', 'active', 'removed']),
  eligible: z.boolean(),
  missing: z.array(z.string()),
});
export const classScheduleListSchema = z.strictObject({
  items: z.array(classScheduleSchema),
});

export const classSessionSchema = z.strictObject({
  id: entityIdSchema,
  eventId: entityIdSchema,
  classOfferingId: entityIdSchema,
  classScheduleId: entityIdSchema,
  offeringName: z.string(),
  levelName: z.string().nullable(),
  title: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  localDate: z.iso.date(),
  timezone: z.string(),
  spaceId: entityIdSchema.nullable(),
  spaceName: z.string().nullable(),
  locationText: z.string().nullable(),
  status: z.enum(['scheduled', 'postponed', 'canceled', 'completed']),
  capacity: z.number().int().positive(),
  enrolledCount: z.number().int().nonnegative(),
  bookedCount: z.number().int().nonnegative(),
  spotsRemaining: z.number().int().nonnegative(),
  instructorNames: z.array(z.string()),
  substitutePersonId: entityIdSchema.nullable(),
});
export type ClassSession = z.infer<typeof classSessionSchema>;

export const classSessionListSchema = z.strictObject({
  items: z.array(classSessionSchema),
});

export const enrollmentStatusSchema = z.enum([
  'trial',
  'active',
  'paused',
  'withdrawn',
  'ended',
]);

export const classEnrollmentSchema = z.strictObject({
  id: entityIdSchema,
  classOfferingId: entityIdSchema,
  offeringName: z.string(),
  personId: entityIdSchema,
  personName: z.string(),
  householdId: entityIdSchema,
  accountId: entityIdSchema,
  status: enrollmentStatusSchema,
  startsOn: z.iso.date(),
  endsOn: z.iso.date().nullable(),
  withdrawEffectiveOn: z.iso.date().nullable(),
  pauseFrom: z.iso.date().nullable(),
  pauseTo: z.iso.date().nullable(),
  classesPerWeek: z.number().int().positive(),
  billingSubscriptionId: entityIdSchema.nullable(),
  version: entityVersionSchema,
  createdAt: z.iso.datetime(),
});
export type ClassEnrollment = z.infer<typeof classEnrollmentSchema>;

export const classEnrollmentListSchema = z.strictObject({
  items: z.array(classEnrollmentSchema),
  nextCursor: z.string().nullable(),
});

export const enrollBodySchema = z.strictObject({
  classOfferingId: entityIdSchema,
  personId: entityIdSchema,
  householdId: entityIdSchema,
  startsOn: z.iso.date(),
  classesPerWeek: z.number().int().min(1).max(14).default(1),
  trial: z.boolean().default(false),
  trialSessionId: entityIdSchema.nullable().default(null),
  paymentMethodId: entityIdSchema.nullable().default(null),
  autopay: z.boolean().default(false),
  billingDay: z.number().int().min(1).max(28).default(1),
});
export type EnrollBody = z.output<typeof enrollBodySchema>;

export const enrollResultSchema = z.strictObject({
  enrollment: classEnrollmentSchema.nullable(),
  waitlistEntry: z
    .strictObject({
      id: entityIdSchema,
      position: z.number().int().positive(),
      status: z.enum(['waiting', 'offered']),
    })
    .nullable(),
  invoiceId: entityIdSchema.nullable(),
  amountDueCents: moneyCentsSchema.nullable(),
  subscriptionId: entityIdSchema.nullable(),
});
export type EnrollResult = z.infer<typeof enrollResultSchema>;

export const withdrawBodySchema = z.strictObject({
  effectiveOn: z.iso.date().nullable().default(null),
  reason: z.string().max(500).nullable().default(null),
  expectedVersion: entityVersionSchema,
});
export const withdrawResultSchema = z.strictObject({
  enrollment: classEnrollmentSchema,
  billThrough: z.iso.date(),
  refundCents: moneyCentsSchema,
});

export const pauseBodySchema = z.strictObject({
  pauseFrom: z.iso.date(),
  pauseTo: z.iso.date(),
  expectedVersion: entityVersionSchema,
});
export const resumeBodySchema = z.strictObject({
  expectedVersion: entityVersionSchema,
});

export const waitlistEntrySchema = z.strictObject({
  id: entityIdSchema,
  classOfferingId: entityIdSchema,
  personId: entityIdSchema,
  personName: z.string(),
  householdId: entityIdSchema,
  position: z.number().int().positive(),
  status: z.enum([
    'waiting',
    'offered',
    'accepted',
    'expired',
    'declined',
    'removed',
  ]),
  offeredAt: z.iso.datetime().nullable(),
  offerExpiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export const waitlistListSchema = z.strictObject({
  items: z.array(waitlistEntrySchema),
});

export const browseClassSchema = z.strictObject({
  classOfferingId: entityIdSchema,
  programId: entityIdSchema,
  programName: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  levelName: z.string().nullable(),
  billing: classBillingSchema,
  priceCents: moneyCentsSchema,
  trialAllowed: z.boolean(),
  trialPriceCents: moneyCentsSchema,
  ageMinMonths: z.number().int().nullable(),
  ageMaxMonths: z.number().int().nullable(),
  capacity: z.number().int().positive(),
  enrolledCount: z.number().int().nonnegative(),
  spotsRemaining: z.number().int().nonnegative(),
  waitlistCount: z.number().int().nonnegative(),
  meetingTimes: z.array(
    z.strictObject({
      weekday: z.string(),
      startTime: z.string(),
      durationMinutes: z.number().int().positive(),
      timezone: z.string(),
      spaceName: z.string().nullable(),
    }),
  ),
  nextSessionAt: z.iso.datetime().nullable(),
});
export const browseClassListSchema = z.strictObject({
  items: z.array(browseClassSchema),
});

export const attendanceMarkSchema = z.strictObject({
  personId: entityIdSchema,
  status: z.enum(['present', 'absent', 'late', 'excused', 'unknown']),
});
export const sessionAttendanceSchema = z.strictObject({
  personId: entityIdSchema,
  personName: z.string(),
  membership: z.enum(['enrolled', 'drop_in', 'makeup', 'trial']),
  status: z.enum(['present', 'absent', 'late', 'excused', 'unknown']),
  checkedInAt: z.iso.datetime().nullable(),
  checkedOutAt: z.iso.datetime().nullable(),
  pickedUpByName: z.string().nullable(),
  canPickUp: z.array(z.string()),
});
export const sessionRosterSchema = z.strictObject({
  session: classSessionSchema,
  attendees: z.array(sessionAttendanceSchema),
});
export const markAttendanceBodySchema = z.strictObject({
  marks: z.array(attendanceMarkSchema).min(1).max(500),
});
export const checkOutBodySchema = z.strictObject({
  personId: entityIdSchema,
  pickedUpByPersonId: entityIdSchema,
});

export const makeupCreditSchema = z.strictObject({
  id: entityIdSchema,
  personId: entityIdSchema,
  personName: z.string(),
  classOfferingId: entityIdSchema,
  offeringName: z.string(),
  sourceEventId: entityIdSchema,
  sourceStartsAt: z.iso.datetime().nullable(),
  expiresOn: z.iso.date(),
  usedEventId: entityIdSchema.nullable(),
  status: z.enum(['available', 'used', 'expired', 'revoked']),
});
export const makeupCreditListSchema = z.strictObject({
  items: z.array(makeupCreditSchema),
});
export const bookMakeupBodySchema = z.strictObject({
  creditId: entityIdSchema,
  classSessionId: entityIdSchema,
});

export const punchCardSchema = z.strictObject({
  id: entityIdSchema,
  personId: entityIdSchema,
  personName: z.string(),
  classOfferingId: entityIdSchema,
  offeringName: z.string(),
  totalUses: z.number().int().positive(),
  remainingUses: z.number().int().nonnegative(),
  expiresOn: z.iso.date().nullable(),
  status: z.enum(['active', 'exhausted', 'expired', 'canceled']),
});
export const punchCardListSchema = z.strictObject({
  items: z.array(punchCardSchema),
});
export const punchCardPurchaseSchema = z.strictObject({
  classOfferingId: entityIdSchema,
  personId: entityIdSchema,
  householdId: entityIdSchema,
});
export const dropInBodySchema = z.strictObject({
  classSessionId: entityIdSchema,
  personId: entityIdSchema,
  householdId: entityIdSchema,
});
export const bookingResultSchema = z.strictObject({
  bookingId: entityIdSchema,
  invoiceId: entityIdSchema.nullable(),
  amountDueCents: moneyCentsSchema.nullable(),
  status: z.enum(['booked', 'attended', 'canceled', 'no_show']),
});

export const tuitionSubscriptionSchema = z.strictObject({
  id: entityIdSchema,
  accountId: entityIdSchema,
  householdId: entityIdSchema,
  householdName: z.string(),
  status: z.enum(['active', 'paused', 'ended']),
  billingDay: z.number().int(),
  paymentMethodId: entityIdSchema.nullable(),
  nextBillOn: z.iso.date(),
  proration: z.enum(['session_count', 'full_month', 'no_charge_after_20th']),
  withdrawalNoticeDays: z.number().int().nonnegative(),
  pausedUntil: z.iso.date().nullable(),
  activeEnrollments: z.number().int().nonnegative(),
  monthlyCents: moneyCentsSchema.nullable(),
  version: entityVersionSchema,
});
export const tuitionSubscriptionListSchema = z.strictObject({
  items: z.array(tuitionSubscriptionSchema),
});
export const subscriptionUpdateSchema = z.strictObject({
  billingDay: z.number().int().min(1).max(28).optional(),
  paymentMethodId: entityIdSchema.nullable().optional(),
  autopayConsent: z.boolean().optional(),
  proration: z
    .enum(['session_count', 'full_month', 'no_charge_after_20th'])
    .optional(),
  withdrawalNoticeDays: z.number().int().min(0).max(365).optional(),
  expectedVersion: entityVersionSchema,
});

export const skillLevelSchema = tenantEntitySchema.extend({
  sportProfileId: entityIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  sortOrder: z.number().int().positive(),
  skillCount: z.number().int().nonnegative(),
  version: entityVersionSchema,
});
export const skillSchema = tenantEntitySchema.extend({
  skillLevelId: entityIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  videoUrl: z.string().nullable(),
  sortOrder: z.number().int().positive(),
  version: entityVersionSchema,
});
export const skillLevelDetailSchema = skillLevelSchema.extend({
  skills: z.array(skillSchema),
});
export const skillLevelListSchema = z.strictObject({
  items: z.array(skillLevelSchema),
});
export const skillLevelBodySchema = z.strictObject({
  sportProfileId: entityIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullable().default(null),
  sortOrder: z.number().int().positive().max(10_000).optional(),
});
export const skillBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(1000).nullable().default(null),
  videoUrl: z.url().nullable().default(null),
  sortOrder: z.number().int().positive().max(10_000).optional(),
});
export const syncLevelsBodySchema = z.strictObject({
  sportProfileId: entityIdSchema,
});

export const skillRecordStatusSchema = z.enum([
  'not_started',
  'in_progress',
  'achieved',
]);
export const athleteSkillRecordSchema = z.strictObject({
  skillId: entityIdSchema,
  skillName: z.string(),
  skillLevelId: entityIdSchema,
  levelName: z.string(),
  status: skillRecordStatusSchema,
  assessedAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
});
export const athleteProgressSchema = z.strictObject({
  personId: entityIdSchema,
  personName: z.string(),
  currentLevelId: entityIdSchema.nullable(),
  currentLevelName: z.string().nullable(),
  levels: z.array(
    z.strictObject({
      levelId: entityIdSchema,
      levelName: z.string(),
      sortOrder: z.number().int(),
      skills: z.array(
        z.strictObject({
          skillId: entityIdSchema,
          name: z.string(),
          status: skillRecordStatusSchema,
          assessedAt: z.iso.datetime().nullable(),
        }),
      ),
      achievedCount: z.number().int().nonnegative(),
      totalCount: z.number().int().nonnegative(),
    }),
  ),
});
export const recordSkillBodySchema = z.strictObject({
  skillId: entityIdSchema,
  status: skillRecordStatusSchema,
  note: z.string().max(500).nullable().default(null),
});
export const sessionSkillMarksSchema = z.strictObject({
  marks: z
    .array(
      z.strictObject({
        personId: entityIdSchema,
        skillId: entityIdSchema,
        status: skillRecordStatusSchema,
      }),
    )
    .min(1)
    .max(2000),
});

export const promotionSchema = z.strictObject({
  id: entityIdSchema,
  personId: entityIdSchema,
  personName: z.string(),
  fromLevelId: entityIdSchema.nullable(),
  fromLevelName: z.string().nullable(),
  toLevelId: entityIdSchema,
  toLevelName: z.string(),
  status: z.enum([
    'recommended',
    'approved',
    'confirmed',
    'completed',
    'declined',
    'canceled',
  ]),
  note: z.string().nullable(),
  recommendedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  targetClassOfferingId: entityIdSchema.nullable(),
  version: entityVersionSchema,
});
export const promotionListSchema = z.strictObject({
  items: z.array(promotionSchema),
});
export const recommendPromotionSchema = z.strictObject({
  personId: entityIdSchema,
  toLevelId: entityIdSchema,
  note: z.string().max(500).nullable().default(null),
  targetClassOfferingId: entityIdSchema.nullable().default(null),
});
export const promotionDecisionSchema = z.strictObject({
  expectedVersion: entityVersionSchema,
  targetClassOfferingId: entityIdSchema.nullable().default(null),
});

export const academyDashboardSchema = z.strictObject({
  enrollmentByLevel: z.array(
    z.strictObject({
      levelId: entityIdSchema.nullable(),
      levelName: z.string(),
      activeEnrollments: z.number().int().nonnegative(),
      capacity: z.number().int().nonnegative(),
    }),
  ),
  enrollmentByClass: z.array(
    z.strictObject({
      classOfferingId: entityIdSchema,
      name: z.string(),
      levelName: z.string().nullable(),
      activeEnrollments: z.number().int().nonnegative(),
      capacity: z.number().int().nonnegative(),
      utilizationBps: z.number().int().nonnegative(),
    }),
  ),
  utilizationHeatmap: z.array(
    z.strictObject({
      weekday: z.number().int().min(1).max(7),
      startHour: z.number().int().min(0).max(23),
      enrolledCount: z.number().int().nonnegative(),
      capacity: z.number().int().nonnegative(),
      utilizationBps: z.number().int().nonnegative(),
    }),
  ),
  churn: z.array(
    z.strictObject({
      month: z.string(),
      withdrawals: z.number().int().nonnegative(),
      enrollments: z.number().int().nonnegative(),
    }),
  ),
  tuitionMrrCents: moneyCentsSchema,
  activeSubscriptions: z.number().int().nonnegative(),
  failedPayments30d: z.number().int().nonnegative(),
  openMakeupCredits: z.number().int().nonnegative(),
  ratioWarnings: z.array(
    z.strictObject({
      classSessionId: entityIdSchema,
      eventId: entityIdSchema,
      offeringName: z.string(),
      startsAt: z.iso.datetime(),
      attendees: z.number().int().nonnegative(),
      instructors: z.number().int().nonnegative(),
      requiredInstructors: z.number().int().nonnegative(),
    }),
  ),
});
export type AcademyDashboard = z.infer<typeof academyDashboardSchema>;

export const classesErrorCodes = [
  'CLASS_OFFERING_FULL',
  'CLASS_AGE_INELIGIBLE',
  'CLASS_ENROLLMENT_EXISTS',
  'CLASS_SESSION_FULL',
  'MAKEUP_CREDIT_UNAVAILABLE',
  'MAKEUP_CREDIT_INELIGIBLE',
  'PUNCH_CARD_EXHAUSTED',
  'WITHDRAWAL_NOTICE_REQUIRED',
  'PROMOTION_STATE_INVALID',
  'INSTRUCTOR_INELIGIBLE',
  'ENROLLMENT_NOT_ACTIVE',
  'SCHEDULE_HAS_ENROLLMENTS',
] as const;

export type InstructorAssign = z.output<typeof instructorAssignSchema>;
export type WaitlistEntry = z.infer<typeof waitlistEntrySchema>;
export type BrowseClass = z.infer<typeof browseClassSchema>;
export type AttendanceMark = z.infer<typeof attendanceMarkSchema>;
export type SessionAttendance = z.infer<typeof sessionAttendanceSchema>;
export type SessionRoster = z.infer<typeof sessionRosterSchema>;
export type MarkAttendanceBody = z.output<typeof markAttendanceBodySchema>;
export type CheckOutBody = z.output<typeof checkOutBodySchema>;
export type MakeupCredit = z.infer<typeof makeupCreditSchema>;
export type BookMakeupBody = z.output<typeof bookMakeupBodySchema>;
export type PunchCard = z.infer<typeof punchCardSchema>;
export type PunchCardPurchase = z.output<typeof punchCardPurchaseSchema>;
export type DropInBody = z.output<typeof dropInBodySchema>;
export type BookingResult = z.infer<typeof bookingResultSchema>;
export type TuitionSubscription = z.infer<typeof tuitionSubscriptionSchema>;
export type SubscriptionUpdate = z.output<typeof subscriptionUpdateSchema>;
export type SkillLevel = z.infer<typeof skillLevelSchema>;
export type Skill = z.infer<typeof skillSchema>;
export type SkillLevelDetail = z.infer<typeof skillLevelDetailSchema>;
export type SkillLevelBody = z.output<typeof skillLevelBodySchema>;
export type SkillBody = z.output<typeof skillBodySchema>;
export type SyncLevelsBody = z.output<typeof syncLevelsBodySchema>;
export type SkillRecordStatus = z.infer<typeof skillRecordStatusSchema>;
export type AthleteSkillRecord = z.infer<typeof athleteSkillRecordSchema>;
export type AthleteProgress = z.infer<typeof athleteProgressSchema>;
export type RecordSkillBody = z.output<typeof recordSkillBodySchema>;
export type SessionSkillMarks = z.output<typeof sessionSkillMarksSchema>;
export type Promotion = z.infer<typeof promotionSchema>;
export type RecommendPromotion = z.output<typeof recommendPromotionSchema>;
export type PromotionDecision = z.output<typeof promotionDecisionSchema>;
export type WithdrawBody = z.output<typeof withdrawBodySchema>;
export type WithdrawResult = z.infer<typeof withdrawResultSchema>;
export type PauseBody = z.output<typeof pauseBodySchema>;
export type ResumeBody = z.output<typeof resumeBodySchema>;
