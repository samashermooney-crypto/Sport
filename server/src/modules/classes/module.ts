import {
  academyDashboardSchema,
  athleteProgressSchema,
  bookMakeupBodySchema,
  bookingResultSchema,
  browseClassListSchema,
  checkOutBodySchema,
  classEnrollmentListSchema,
  classEnrollmentSchema,
  classOfferingBodySchema,
  classOfferingListSchema,
  classOfferingSchema,
  classOfferingUpdateSchema,
  classScheduleBodySchema,
  classScheduleListSchema,
  classScheduleSchema,
  classScheduleUpdateSchema,
  classSessionListSchema,
  classSessionSchema,
  dropInBodySchema,
  enrollBodySchema,
  enrollResultSchema,
  instructorAssignSchema,
  makeupCreditListSchema,
  markAttendanceBodySchema,
  pauseBodySchema,
  promotionListSchema,
  promotionSchema,
  punchCardListSchema,
  punchCardPurchaseSchema,
  recommendPromotionSchema,
  recordSkillBodySchema,
  resumeBodySchema,
  sessionRosterSchema,
  sessionSkillMarksSchema,
  skillBodySchema,
  skillLevelBodySchema,
  skillLevelDetailSchema,
  skillLevelListSchema,
  skillLevelSchema,
  skillSchema,
  subscriptionUpdateSchema,
  syncLevelsBodySchema,
  tuitionSubscriptionListSchema,
  tuitionSubscriptionSchema,
  waitlistListSchema,
  withdrawBodySchema,
  withdrawResultSchema,
} from '@shared/schemas/classes';
import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createClassesRouter } from './routes';
import { runTuitionJob } from './tuition-job';

const okSchema = z.strictObject({ ok: z.literal(true) });
const expectedVersionSchema = z.strictObject({
  expectedVersion: z.int().positive(),
});
const offeringResponseSchema = z.strictObject({
  offering: classOfferingSchema,
});
const scheduleResponseSchema = z.strictObject({
  schedule: classScheduleSchema,
});
const sessionResponseSchema = z.strictObject({
  session: classSessionSchema,
});
const enrollmentResponseSchema = z.strictObject({
  enrollment: classEnrollmentSchema,
});
const subscriptionResponseSchema = z.strictObject({
  subscription: tuitionSubscriptionSchema,
});
const levelResponseSchema = z.strictObject({ level: skillLevelSchema });
const levelDetailResponseSchema = z.strictObject({
  level: skillLevelDetailSchema,
});
const skillResponseSchema = z.strictObject({ skill: skillSchema });
const promotionResponseSchema = z.strictObject({ promotion: promotionSchema });
const instructorListSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      personId: z.uuid(),
      name: z.string(),
      status: z.string(),
      eligible: z.boolean(),
      missing: z.array(
        z.looseObject({ code: z.string(), message: z.string() }),
      ),
    }),
  ),
});
const instructorResponseSchema = z.strictObject({
  instructor: z.strictObject({
    id: z.uuid(),
    status: z.string(),
    missing: z.array(z.looseObject({ code: z.string(), message: z.string() })),
  }),
});
const markResultSchema = z.strictObject({
  marked: z.number().int().nonnegative(),
  creditsIssued: z.number().int().nonnegative(),
});
const checkInResultSchema = z.strictObject({ checkedInAt: z.iso.datetime() });
const checkOutResultSchema = z.strictObject({
  checkedOutAt: z.iso.datetime(),
  pickedUpBy: z.string(),
});
const pickupPeopleSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      personId: z.uuid(),
      name: z.string(),
    }),
  ),
});
const substituteBodySchema = z.strictObject({ personId: z.uuid() });
const substituteResponseSchema = z.strictObject({
  substitute: z.strictObject({ personId: z.uuid(), name: z.string() }),
});
const syncResultSchema = z.strictObject({
  levelsCreated: z.number().int().nonnegative(),
  skillsCreated: z.number().int().nonnegative(),
});
const punchCardPurchaseResultSchema = z.strictObject({
  punchCardId: z.uuid(),
  invoiceId: z.uuid(),
  amountCents: z.number().int().nonnegative(),
});
const cancelSessionBodySchema = z.strictObject({
  reason: z.string().max(500).nullable().optional(),
});
const checkInBodySchema = z.strictObject({ personId: z.uuid() });
const promotionConfirmBodySchema = z.strictObject({
  expectedVersion: z.int().positive(),
  targetClassOfferingId: z.uuid().nullable().optional(),
});
const punchCardBookBodySchema = z.strictObject({
  classSessionId: z.uuid(),
});

export const moduleDefinition = {
  name: 'classes',
  path: '/api/v1/classes',
  router: createClassesRouter,
  jobs: [
    {
      name: 'classes.tuition',
      cron: '0 6 * * *',
      run: runTuitionJob,
    },
  ],
  permissions: ['classes.manage', 'classes.instruct'],
  notificationTypes: [
    'registration.waitlist_offer',
    'registration.offered',
    'invoice.issued',
  ],
  errorCodes: [
    'CLASS_OFFERING_FULL',
    'CLASS_AGE_INELIGIBLE',
    'CLASS_SESSION_FULL',
    'MAKEUP_CREDIT_UNAVAILABLE',
  ],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/offerings',
      summary: 'List class offerings',
      response: classOfferingListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/offerings',
      summary: 'Create a class offering',
      body: classOfferingBodySchema,
      response: offeringResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/offerings/{offeringId}',
      summary: 'Read a class offering',
      response: offeringResponseSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/classes/orgs/{orgId}/offerings/{offeringId}',
      summary: 'Versioned class offering update',
      body: classOfferingUpdateSchema,
      response: offeringResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/offerings/{offeringId}/archive',
      summary: 'Archive a class offering',
      body: expectedVersionSchema,
      response: okSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/offerings/{offeringId}/schedules',
      summary: 'List recurring schedules for an offering',
      response: classScheduleListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/offerings/{offeringId}/schedules',
      summary: 'Create a recurring schedule and materialize its class sessions',
      body: classScheduleBodySchema,
      response: scheduleResponseSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/classes/orgs/{orgId}/schedules/{scheduleId}',
      summary: 'Update a schedule and rematerialize future sessions',
      body: classScheduleUpdateSchema,
      response: scheduleResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/schedules/{scheduleId}/end',
      summary: 'End a schedule and cancel future sessions',
      body: expectedVersionSchema,
      response: okSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/schedules/{scheduleId}/instructors',
      summary: 'List instructors with compliance eligibility',
      response: instructorListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/schedules/{scheduleId}/instructors',
      summary: 'Assign an instructor with compliance gating',
      body: instructorAssignSchema,
      response: instructorResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/schedules/{scheduleId}/instructors/{personId}/remove',
      summary: 'Remove an instructor from a schedule',
      response: okSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/sessions',
      summary: 'List class sessions in a date range',
      response: classSessionListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/sessions/{sessionId}',
      summary: 'Read a class session',
      response: sessionResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/sessions/{sessionId}/substitute',
      summary: 'Assign a compliant substitute instructor to a future class',
      body: substituteBodySchema,
      response: substituteResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/sessions/{sessionId}/roster',
      summary: 'Read the session roster and attendance',
      response: sessionRosterSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/sessions/{sessionId}/cancel',
      summary: 'Cancel a class session',
      body: cancelSessionBodySchema,
      response: okSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/sessions/{sessionId}/attendance',
      summary: 'Mark session attendance; absences create make-up credits',
      body: markAttendanceBodySchema,
      response: markResultSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/sessions/{sessionId}/check-in',
      summary: 'Check an athlete into a session',
      body: checkInBodySchema,
      response: checkInResultSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/sessions/{sessionId}/check-out',
      summary: 'Check out with verified pickup',
      body: checkOutBodySchema,
      response: checkOutResultSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/sessions/{sessionId}/people/{personId}/pickups',
      summary: 'List people currently authorized to pick up an athlete',
      response: pickupPeopleSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/enrollments',
      summary: 'List enrollments',
      response: classEnrollmentListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/enrollments',
      summary: 'Staff enrollment (bypasses level gate)',
      body: enrollBodySchema,
      response: enrollResultSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/enrollments/{enrollmentId}',
      summary: 'Read an enrollment',
      response: enrollmentResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/enrollments/{enrollmentId}/withdraw',
      summary: 'Withdraw with notice period and refund calculation',
      body: withdrawBodySchema,
      response: withdrawResultSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/enrollments/{enrollmentId}/pause',
      summary: 'Pause an enrollment for a vacation window',
      body: pauseBodySchema,
      response: enrollmentResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/enrollments/{enrollmentId}/resume',
      summary: 'Resume a paused enrollment',
      body: resumeBodySchema,
      response: enrollmentResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/offerings/{offeringId}/waitlist',
      summary: 'List waitlist entries for an offering',
      response: waitlistListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/waitlist/{entryId}/remove',
      summary: 'Remove a waitlist entry',
      response: okSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/subscriptions',
      summary: 'List tuition subscriptions',
      response: tuitionSubscriptionListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/subscriptions/{subscriptionId}',
      summary: 'Read a tuition subscription',
      response: subscriptionResponseSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/classes/orgs/{orgId}/subscriptions/{subscriptionId}',
      summary: 'Update billing day, autopay, proration, notice period',
      body: subscriptionUpdateSchema,
      response: subscriptionResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/levels',
      summary: 'List skill levels',
      response: skillLevelListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/levels',
      summary: 'Create a skill level',
      body: skillLevelBodySchema,
      response: levelResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/levels/{levelId}',
      summary: 'Read a skill level with its skills',
      response: levelDetailResponseSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/classes/orgs/{orgId}/levels/{levelId}',
      summary: 'Versioned skill level update',
      body: skillLevelBodySchema
        .partial()
        .extend({ expectedVersion: z.int().positive() }),
      response: levelResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/levels/{levelId}/skills',
      summary: 'Add a skill to a level',
      body: skillBodySchema,
      response: skillResponseSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/classes/orgs/{orgId}/skills/{skillId}',
      summary: 'Versioned skill update',
      body: skillBodySchema
        .partial()
        .extend({ expectedVersion: z.int().positive() }),
      response: skillResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/levels/sync',
      summary: 'Import levels and skills from the sport profile',
      body: syncLevelsBodySchema,
      response: syncResultSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/people/{personId}/skills',
      summary: 'Record an athlete skill assessment',
      body: recordSkillBodySchema,
      response: okSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/sessions/{sessionId}/skills',
      summary: 'Record skill marks for session attendees',
      body: sessionSkillMarksSchema,
      response: okSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/people/{personId}/progress',
      summary: 'Guardian-visible athlete progress report',
      response: athleteProgressSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/promotions',
      summary: 'List level promotions',
      response: promotionListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/promotions',
      summary: 'Recommend a level promotion',
      body: recommendPromotionSchema,
      response: promotionResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/promotions/{promotionId}',
      summary: 'Read a promotion',
      response: promotionResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/promotions/{promotionId}/approve',
      summary: 'Staff approval of a promotion',
      body: expectedVersionSchema,
      response: promotionResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/promotions/{promotionId}/cancel',
      summary: 'Cancel a promotion',
      body: expectedVersionSchema,
      response: promotionResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/promotions/{promotionId}/certificate.pdf',
      summary: 'Download the promotion certificate PDF',
      response: okSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/dashboard',
      summary: 'Academy dashboard aggregates',
      response: academyDashboardSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/me/browse',
      summary: 'Browse class offerings with spot availability',
      response: browseClassListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/me/enrollments',
      summary: 'List family enrollments',
      response: classEnrollmentListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/enrollments',
      summary: 'Enroll or join the waitlist',
      body: enrollBodySchema,
      response: enrollResultSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/enrollments/{enrollmentId}/withdraw',
      summary: 'Withdraw with notice period',
      body: withdrawBodySchema,
      response: withdrawResultSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/enrollments/{enrollmentId}/pause',
      summary: 'Request a pause window',
      body: pauseBodySchema,
      response: enrollmentResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/enrollments/{enrollmentId}/resume',
      summary: 'Resume a paused enrollment',
      body: resumeBodySchema,
      response: enrollmentResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/me/sessions',
      summary: 'List bookable class sessions',
      response: classSessionListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/me/makeup-credits',
      summary: 'List family make-up credits',
      response: makeupCreditListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/me/makeup-credits/{creditId}/sessions',
      summary: 'List eligible open class sessions for a family make-up credit',
      response: classSessionListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/makeup-credits/{creditId}/book',
      summary: 'Book a make-up credit into an eligible session',
      body: bookMakeupBodySchema,
      response: bookingResultSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/drop-in',
      summary: 'Purchase a drop-in session',
      body: dropInBodySchema,
      response: bookingResultSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/me/punch-cards',
      summary: 'List family punch cards',
      response: punchCardListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/punch-cards',
      summary: 'Purchase a punch card',
      body: punchCardPurchaseSchema,
      response: punchCardPurchaseResultSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/punch-cards/{punchCardId}/book',
      summary: 'Spend a punch on a session',
      body: punchCardBookBodySchema,
      response: bookingResultSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/bookings/{bookingId}/cancel',
      summary: 'Cancel a session booking',
      response: okSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/me/subscriptions',
      summary: 'List family tuition subscriptions',
      response: tuitionSubscriptionListSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/classes/orgs/{orgId}/me/subscriptions/{subscriptionId}',
      summary: 'Update family payment method or autopay',
      body: subscriptionUpdateSchema,
      response: subscriptionResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/me/waitlist',
      summary: 'List family waitlist entries and open offers',
      response: waitlistListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/waitlist/{entryId}/accept',
      summary: 'Accept a waitlist offer and enroll',
      body: enrollBodySchema,
      response: enrollResultSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/waitlist/{entryId}/decline',
      summary: 'Decline a waitlist offer',
      response: okSchema,
    },
    {
      method: 'get',
      path: '/api/v1/classes/orgs/{orgId}/me/promotions',
      summary: 'List family promotion decisions',
      response: promotionListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/promotions/{promotionId}/confirm',
      summary: 'Guardian confirmation of a promotion',
      body: promotionConfirmBodySchema,
      response: promotionResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/classes/orgs/{orgId}/me/promotions/{promotionId}/decline',
      summary: 'Guardian decline of a promotion',
      body: expectedVersionSchema,
      response: promotionResponseSchema,
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
