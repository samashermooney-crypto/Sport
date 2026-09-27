import express from 'express';
import { z } from 'zod';

import type { AuthDependencies } from '../auth/routes';
import { mutationOriginIsValid, orgActor, requireAnyRole, sendModuleError } from '../compliance/access';

import {
  assignClassInstructor,
  bookClassMakeup,
  ClassError,
  createClassOffering,
  createLevelRecommendation,
  decideLevelRecommendation,
  enrollClass,
  generateClassSchedule,
  getClassDashboard,
  listClassEnrollments,
  listClassOfferings,
  listClassSessions,
  listFamilyMakeupCredits,
  listFamilySkillReport,
  recordClassAttendance,
  updateClassSkill,
  withdrawClassEnrollment,
} from './service';
import type { ClassDependencies } from './service';
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

const uuid = (value: unknown) => z.uuid().parse(value);

export function createClassesRouter(dependencies: AuthDependencies): express.Router {
  const router = express.Router();
  const classes: ClassDependencies = { database: dependencies.database, clock: dependencies.clock };
  router.use((_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  router.use((request, response, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !mutationOriginIsValid(request, dependencies.appUrl)) {
      response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Request origin could not be verified' } });
      return;
    }
    next();
  });
  router.use(express.json({ limit: '64kb' }));
  const endpoint = (action: (request: express.Request, response: express.Response) => Promise<void>) =>
    async (request: express.Request, response: express.Response) => {
      try { await action(request, response); }
      catch (error) {
        if (error instanceof ClassError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
        sendModuleError(response, error);
      }
    };
  const staff = async (request: express.Request) => {
    const actor = await orgActor(dependencies, request);
    requireAnyRole(actor.roles, ['owner', 'admin', 'director', 'registrar', 'scheduler', 'compliance']);
    return actor;
  };

  router.get('/orgs/:orgId/classes', endpoint(async (request, response) => {
    const actor = await orgActor(dependencies, request);
    const ageMonths = request.query.ageMonths === undefined ? undefined : z.coerce.number().int().min(0).max(240).parse(request.query.ageMonths);
    const level = request.query.level === undefined ? undefined : z.string().max(80).parse(request.query.level);
    const day = request.query.day === undefined ? undefined : z.enum(['MO','TU','WE','TH','FR','SA','SU']).parse(request.query.day);
    response.json(await listClassOfferings(classes, actor.context, {
      ...(ageMonths === undefined ? {} : { ageMonths }),
      ...(level === undefined ? {} : { level }),
      ...(day === undefined ? {} : { day }),
    }));
  }));
  router.get('/orgs/:orgId/classes/dashboard', endpoint(async (request, response) => {
    const actor = await staff(request);
    response.json(await getClassDashboard(classes, actor.context));
  }));
  router.post('/orgs/:orgId/programs/:programId/classes', endpoint(async (request, response) => {
    const actor = await staff(request);
    response.status(201).json(await createClassOffering(classes, actor.context, uuid(request.params.programId), classOfferingSchema.parse(request.body)));
  }));
  router.post('/orgs/:orgId/classes/:offeringId/schedule', endpoint(async (request, response) => {
    const actor = await staff(request);
    response.status(201).json(await generateClassSchedule(classes, actor.context, uuid(request.params.offeringId), classScheduleSchema.parse(request.body)));
  }));
  router.get('/orgs/:orgId/classes/:offeringId/sessions', endpoint(async (request, response) => {
    const actor = await orgActor(dependencies, request);
    const from = request.query.from === undefined ? undefined : z.iso.date().parse(request.query.from);
    const to = request.query.to === undefined ? undefined : z.iso.date().parse(request.query.to);
    response.json(await listClassSessions(classes, actor.context, uuid(request.params.offeringId), from, to));
  }));
  router.get('/orgs/:orgId/classes/:offeringId/enrollments', endpoint(async (request, response) => {
    const actor = await staff(request);
    response.json(await listClassEnrollments(classes, actor.context, uuid(request.params.offeringId)));
  }));
  router.post('/orgs/:orgId/classes/:offeringId/enrollments', endpoint(async (request, response) => {
    const actor = await orgActor(dependencies, request);
    response.status(201).json(await enrollClass(classes, actor.context, uuid(request.params.offeringId), classEnrollmentSchema.parse(request.body)));
  }));
  router.post('/orgs/:orgId/classes/:offeringId/instructors', endpoint(async (request, response) => {
    const actor = await staff(request);
    const body = z.strictObject({ personId: z.uuid(), role: z.enum(['lead','instructor','substitute']), startsOn: z.iso.date(), endsOn: z.iso.date().nullable().default(null) }).parse(request.body);
    response.status(201).json(await assignClassInstructor(classes, actor.context, uuid(request.params.offeringId), body.personId, body.role, body.startsOn, body.endsOn));
  }));
  router.post('/orgs/:orgId/classes/sessions/:sessionId/attendance', endpoint(async (request, response) => {
    const actor = await staff(request);
    response.json(await recordClassAttendance(classes, actor.context, uuid(request.params.sessionId), classAttendanceSchema.parse(request.body)));
  }));
  router.get('/orgs/:orgId/me/makeup-credits', endpoint(async (request, response) => {
    const actor = await orgActor(dependencies, request);
    response.json(await listFamilyMakeupCredits(classes, actor.context));
  }));
  router.post('/orgs/:orgId/me/makeup-bookings', endpoint(async (request, response) => {
    const actor = await orgActor(dependencies, request);
    response.status(201).json(await bookClassMakeup(classes, actor.context, makeupBookingSchema.parse(request.body)));
  }));
  router.get('/orgs/:orgId/me/enrollments/:enrollmentId/progress', endpoint(async (request, response) => {
    const actor = await orgActor(dependencies, request);
    response.json(await listFamilySkillReport(classes, actor.context, uuid(request.params.enrollmentId)));
  }));
  router.post('/orgs/:orgId/skills', endpoint(async (request, response) => {
    const actor = await staff(request);
    response.status(201).json(await updateClassSkill(classes, actor.context, skillUpdateSchema.parse(request.body)));
  }));
  router.post('/orgs/:orgId/level-recommendations', endpoint(async (request, response) => {
    const actor = await staff(request);
    response.status(201).json(await createLevelRecommendation(classes, actor.context, levelRecommendationSchema.parse(request.body)));
  }));
  router.post('/orgs/:orgId/level-recommendations/:recommendationId/decision', endpoint(async (request, response) => {
    const actor = await orgActor(dependencies, request);
    const body = guardianPromotionDecisionSchema.parse(request.body);
    response.json(await decideLevelRecommendation(classes, actor.context, uuid(request.params.recommendationId), body.decision, body.expectedVersion));
  }));
  router.post('/orgs/:orgId/classes/:offeringId/withdrawals', endpoint(async (request, response) => {
    const actor = await orgActor(dependencies, request);
    const body = z.strictObject({ enrollmentId: z.uuid(), noticeOn: z.iso.date() }).parse(request.body);
    // Withdrawal timing is kept in the enrollment record; invoice credits follow the shared proration rule.
    const result = await withdrawClassEnrollment(classes, actor.context, uuid(request.params.offeringId), body.enrollmentId, body.noticeOn);
    response.json(result);
  }));
  return router;
}
