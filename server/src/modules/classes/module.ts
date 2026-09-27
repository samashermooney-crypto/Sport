import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { runClassTuitionBilling } from './service';
import { createClassesRouter } from './routes';
import {
  classAttendanceSchema,
  classEnrollmentSchema,
  classOfferingSchema,
  classScheduleSchema,
  guardianPromotionDecisionSchema,
  levelRecommendationSchema,
  makeupBookingSchema,
  skillUpdateSchema,
} from './schemas';

const base = '/api/v1/classes';
const descriptors = [
  ['get', '/orgs/{orgId}/classes', 'Browse active class offerings'],
  ['get', '/orgs/{orgId}/classes/dashboard', 'Read class utilization and ratio warnings'],
  ['post', '/orgs/{orgId}/programs/{programId}/classes', 'Create a class offering', classOfferingSchema],
  ['post', '/orgs/{orgId}/classes/{offeringId}/schedule', 'Generate class sessions from a recurrence', classScheduleSchema],
  ['post', '/orgs/{orgId}/classes/{offeringId}/enrollments', 'Enroll in a class or join its waitlist', classEnrollmentSchema],
  ['post', '/orgs/{orgId}/classes/sessions/{sessionId}/attendance', 'Record class attendance and pickup', classAttendanceSchema],
  ['get', '/orgs/{orgId}/me/makeup-credits', 'List family make-up credits'],
  ['post', '/orgs/{orgId}/me/makeup-bookings', 'Book a make-up class', makeupBookingSchema],
  ['get', '/orgs/{orgId}/me/enrollments/{enrollmentId}/progress', 'Read a guardian skill report'],
  ['post', '/orgs/{orgId}/skills', 'Update an athlete skill record', skillUpdateSchema],
  ['post', '/orgs/{orgId}/level-recommendations', 'Recommend a class level promotion', levelRecommendationSchema],
  ['post', '/orgs/{orgId}/level-recommendations/{recommendationId}/decision', 'Record guardian promotion decision', guardianPromotionDecisionSchema],
] as const;

export const moduleDefinition = {
  name: 'classes',
  path: base,
  router: createClassesRouter,
  jobs: [{ name: 'classes.tuition', cron: '0 8 * * *', run: runClassTuitionBilling }],
  permissions: ['classes.manage', 'classes.enroll', 'classes.attendance', 'classes.progress.read'],
  notificationTypes: ['classes.level-recommendation', 'classes.tuition-due'],
  errorCodes: ['AGE_INELIGIBLE', 'SESSION_FULL', 'CREDIT_UNAVAILABLE', 'COMPLIANCE_REQUIRED'],
  openapiRoutes: descriptors.map(([method, suffix, summary, body]) => ({
    method,
    path: `${base}${suffix}`,
    summary,
    response: z.json(),
    ...(body ? { body } : {}),
    tags: ['classes'],
  })),
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
