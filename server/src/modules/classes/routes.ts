import {
  attendanceMarkSchema,
  bookMakeupBodySchema,
  checkOutBodySchema,
  classOfferingBodySchema,
  classOfferingUpdateSchema,
  classScheduleBodySchema,
  classScheduleUpdateSchema,
  dropInBodySchema,
  enrollBodySchema,
  instructorAssignSchema,
  markAttendanceBodySchema,
  pauseBodySchema,
  punchCardPurchaseSchema,
  recommendPromotionSchema,
  recordSkillBodySchema,
  resumeBodySchema,
  sessionSkillMarksSchema,
  skillBodySchema,
  skillLevelBodySchema,
  subscriptionUpdateSchema,
  syncLevelsBodySchema,
  waitlistListSchema,
  withdrawBodySchema,
} from '@shared/schemas/classes';
import { apiErrorSchema } from '@shared/schemas/errors';
import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import {
  requireClassManager,
  requireClassStaff,
  requireGuardian,
  requireLinkedPerson,
  requireMember,
  requireSessionStaffOrInstructor,
} from './access';
import { PostgresClassAttendance } from './attendance';
import { PostgresClassBookings } from './bookings';
import { PostgresAcademyDashboard } from './dashboard';
import { PostgresClassEnrollments } from './enrollments';
import {
  ClassesAccessError,
  ClassesConflictError,
  ClassesError,
  ClassesNotFoundError,
} from './errors';
import { PostgresClassOfferings } from './offerings';
import { PostgresClassPromotions } from './promotions';
import { PostgresClassSchedules } from './schedules';
import { PostgresClassSessions } from './sessions';
import { PostgresClassSkills } from './skills';
import { PostgresTuitionSubscriptions } from './tuition';

const archiveBodySchema = z.strictObject({
  expectedVersion: z.int().positive(),
});

const versionBodySchema = z.strictObject({
  expectedVersion: z.int().positive(),
});

const cancelSessionBodySchema = z.strictObject({
  reason: z.string().max(500).nullable().optional(),
});

const checkInBodySchema = z.strictObject({
  personId: z.uuid(),
});
const substituteBodySchema = z.strictObject({ personId: z.uuid() });

const promotionDecisionBodySchema = z.strictObject({
  expectedVersion: z.int().positive(),
  targetClassOfferingId: z.uuid().nullable().optional(),
});

const portalEnrollBodySchema = enrollBodySchema.extend({
  householdId: z.uuid().optional(),
});
const portalDropInBodySchema = dropInBodySchema.extend({
  householdId: z.uuid().optional(),
});
const portalPunchCardPurchaseSchema = punchCardPurchaseSchema.extend({
  householdId: z.uuid().optional(),
});

const waitlistAcceptBodySchema = enrollBodySchema;

function writeOriginValid(request: express.Request, appUrl: string): boolean {
  const bearer =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  return (
    request.get('X-Athlentry-Request') === '1' &&
    (request.get('Origin') === new URL(appUrl).origin ||
      (bearer && request.get('Origin') === undefined))
  );
}

function clean<T extends object>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}

function sendError(response: express.Response, error: unknown): void {
  const status =
    error instanceof z.ZodError
      ? 400
      : error instanceof ClassesError
        ? error.status
        : error instanceof Error &&
            'status' in error &&
            typeof error.status === 'number'
          ? error.status
          : 500;
  response.status(status).json(
    apiErrorSchema.parse({
      error: {
        code:
          status === 400
            ? 'VALIDATION_ERROR'
            : status === 401
              ? 'UNAUTHENTICATED'
              : status === 403
                ? 'FORBIDDEN'
                : status === 404
                  ? 'NOT_FOUND'
                  : status === 409
                    ? 'CONFLICT'
                    : 'INTERNAL_ERROR',
        message:
          status === 500
            ? 'Request could not be completed'
            : error instanceof z.ZodError
              ? 'Request failed validation'
              : error instanceof Error
                ? error.message
                : 'Request failed',
      },
    }),
  );
}

type Handler = (
  request: express.Request,
  response: express.Response,
) => Promise<void>;

function route(handler: Handler): express.RequestHandler {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      sendError(response, error);
    }
  };
}

async function holidayDates(
  dependencies: AuthDependencies,
  context: OrgContext,
  schedule: {
    spaceId?: string | null;
    startsOn: string;
    endsOn: string | null;
  },
  timezone: string,
): Promise<string[]> {
  const withOrg = createWithOrg(dependencies.database);
  return withOrg(context, async (trx) => {
    const windowStart = `${schedule.startsOn}T00:00:00Z`;
    const windowEnd = schedule.endsOn
      ? `${schedule.endsOn}T23:59:59Z`
      : `${schedule.startsOn.slice(0, 4)}-12-31T23:59:59Z`;
    const closureRows = await trx
      .selectFrom('closures')
      .select(['starts_at', 'ends_at', 'scope_type', 'scope_id'])
      .where('org_id', '=', context.orgId)
      .where('ends_at', '>=', new Date(windowStart))
      .where('starts_at', '<=', new Date(windowEnd))
      .execute();
    const blackoutRows = schedule.spaceId
      ? await trx
          .selectFrom('space_blackouts')
          .select(['starts_at', 'ends_at'])
          .where('org_id', '=', context.orgId)
          .where('space_id', '=', schedule.spaceId)
          .where('ends_at', '>=', new Date(windowStart))
          .where('starts_at', '<=', new Date(windowEnd))
          .execute()
      : [];
    const dates = new Set<string>();
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    const addWindow = (start: Date, end: Date) => {
      const cursor = new Date(
        Date.UTC(
          start.getUTCFullYear(),
          start.getUTCMonth(),
          start.getUTCDate(),
        ),
      );
      const limit = end.getTime();
      while (cursor.getTime() <= limit + 86_400_000) {
        const day = fmt.format(cursor);
        if (
          day >= schedule.startsOn &&
          (!schedule.endsOn || day <= schedule.endsOn)
        ) {
          dates.add(day);
        }
        if (schedule.endsOn && day >= schedule.endsOn) break;
        if (dates.size > 370) break;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    };
    for (const closure of closureRows) {
      if (
        closure.scope_type !== 'org' &&
        (!schedule.spaceId || closure.scope_id !== schedule.spaceId)
      )
        continue;
      addWindow(closure.starts_at, closure.ends_at);
    }
    for (const blackout of blackoutRows)
      addWindow(blackout.starts_at, blackout.ends_at);
    return [...dates].sort();
  });
}

export function createClassesRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  const withOrg = createWithOrg(dependencies.database);

  const context = async (request: express.Request): Promise<OrgContext> => {
    const session = await requireSession(dependencies, request);
    const impersonation = requestImpersonation(request);
    return {
      orgId: z.uuid().parse(request.params.orgId),
      actor: { accountId: impersonation?.accountId ?? session.accountId },
    };
  };

  const write = (request: express.Request): void => {
    if (!writeOriginValid(request, dependencies.appUrl))
      throw new ClassesAccessError('Invalid write origin');
  };

  const key = (request: express.Request): string =>
    z.uuid().parse(request.get('Idempotency-Key'));

  const personHousehold = async (
    ctx: OrgContext,
    personId: string,
    supplied?: string,
  ): Promise<string> => {
    if (supplied) {
      const membership = await withOrg(ctx, (trx) =>
        trx
          .selectFrom('household_members')
          .select('household_id')
          .where('org_id', '=', ctx.orgId)
          .where('person_id', '=', personId)
          .where('household_id', '=', supplied)
          .where('removed_at', 'is', null)
          .executeTakeFirst(),
      );
      if (!membership) throw new ClassesNotFoundError('Household not found');
      return membership.household_id;
    }
    const row = await withOrg(ctx, (trx) =>
      trx
        .selectFrom('household_members')
        .select('household_id')
        .where('org_id', '=', ctx.orgId)
        .where('person_id', '=', personId)
        .where('removed_at', 'is', null)
        .orderBy('created_at')
        .limit(1)
        .executeTakeFirst(),
    );
    if (!row)
      throw new ClassesConflictError(
        'The athlete must belong to a household before enrolling',
      );
    return row.household_id;
  };

  const services = async (request: express.Request) => {
    const ctx = await context(request);
    return {
      ctx,
      offerings: new PostgresClassOfferings(dependencies.database, ctx),
      schedules: new PostgresClassSchedules(dependencies.database, ctx),
      sessions: new PostgresClassSessions(dependencies.database, ctx),
      enrollments: new PostgresClassEnrollments(dependencies.database, ctx),
      attendance: new PostgresClassAttendance(dependencies.database, ctx),
      bookings: new PostgresClassBookings(dependencies.database, ctx),
      skills: new PostgresClassSkills(dependencies.database, ctx),
      promotions: new PostgresClassPromotions(dependencies.database, ctx),
      subscriptions: new PostgresTuitionSubscriptions(
        dependencies.database,
        ctx,
      ),
      dashboard: new PostgresAcademyDashboard(dependencies.database, ctx),
    };
  };

  // ---------- Offerings (staff) ----------

  router.get(
    '/orgs/:orgId/offerings',
    route(async (request, response) => {
      const { ctx, offerings } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const query = z
        .strictObject({
          programId: z.uuid().optional(),
          levelId: z.uuid().optional(),
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        })
        .parse(request.query);
      response.json(await offerings.list(clean(query)));
    }),
  );

  router.post(
    '/orgs/:orgId/offerings',
    route(async (request, response) => {
      write(request);
      const { ctx, offerings } = await services(request);
      await requireClassManager(dependencies.database, ctx);
      response.status(201).json({
        offering: await offerings.create(
          classOfferingBodySchema.parse(request.body),
        ),
      });
    }),
  );

  router.get(
    '/orgs/:orgId/offerings/:offeringId',
    route(async (request, response) => {
      const { ctx, offerings } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json({
        offering: await offerings.get(
          z.uuid().parse(request.params.offeringId),
        ),
      });
    }),
  );

  router.patch(
    '/orgs/:orgId/offerings/:offeringId',
    route(async (request, response) => {
      write(request);
      const { ctx, offerings } = await services(request);
      await requireClassManager(dependencies.database, ctx);
      response.json({
        offering: await offerings.update(
          z.uuid().parse(request.params.offeringId),
          classOfferingUpdateSchema.parse(request.body),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/offerings/:offeringId/archive',
    route(async (request, response) => {
      write(request);
      const { ctx, offerings } = await services(request);
      await requireClassManager(dependencies.database, ctx);
      const body = archiveBodySchema.parse(request.body);
      await offerings.archive(
        z.uuid().parse(request.params.offeringId),
        body.expectedVersion,
      );
      response.status(204).end();
    }),
  );

  // ---------- Schedules (staff) ----------

  router.get(
    '/orgs/:orgId/offerings/:offeringId/schedules',
    route(async (request, response) => {
      const { ctx, schedules } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json({
        items: await schedules.listForOffering(
          z.uuid().parse(request.params.offeringId),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/offerings/:offeringId/schedules',
    route(async (request, response) => {
      write(request);
      const { ctx, schedules } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const body = classScheduleBodySchema.parse(request.body);
      const holidays = await holidayDates(
        dependencies,
        ctx,
        {
          spaceId: body.spaceId,
          startsOn: body.termStart,
          endsOn: body.termEnd,
        },
        body.timezone,
      );
      response.status(201).json({
        schedule: await schedules.create(
          z.uuid().parse(request.params.offeringId),
          body,
          holidays,
        ),
      });
    }),
  );

  router.patch(
    '/orgs/:orgId/schedules/:scheduleId',
    route(async (request, response) => {
      write(request);
      const { ctx, schedules } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const body = classScheduleUpdateSchema.parse(request.body);
      const existing = await schedules.get(
        z.uuid().parse(request.params.scheduleId),
      );
      const holidays = await holidayDates(
        dependencies,
        ctx,
        {
          spaceId: body.spaceId ?? existing.spaceId,
          startsOn: body.termStart ?? existing.termStart,
          endsOn: body.termEnd === undefined ? existing.termEnd : body.termEnd,
        },
        body.timezone ?? existing.timezone,
      );
      response.json({
        schedule: await schedules.update(
          z.uuid().parse(request.params.scheduleId),
          body,
          holidays,
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/schedules/:scheduleId/end',
    route(async (request, response) => {
      write(request);
      const { ctx, schedules } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const body = versionBodySchema.parse(request.body);
      await schedules.end(
        z.uuid().parse(request.params.scheduleId),
        body.expectedVersion,
      );
      response.status(204).end();
    }),
  );

  router.get(
    '/orgs/:orgId/schedules/:scheduleId/instructors',
    route(async (request, response) => {
      const { ctx, schedules } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json({
        items: await schedules.instructorRoster(
          z.uuid().parse(request.params.scheduleId),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/schedules/:scheduleId/instructors',
    route(async (request, response) => {
      write(request);
      const { ctx, schedules } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.status(201).json({
        instructor: await schedules.assignInstructor(
          z.uuid().parse(request.params.scheduleId),
          instructorAssignSchema.parse(request.body),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/schedules/:scheduleId/instructors/:personId/remove',
    route(async (request, response) => {
      write(request);
      const { ctx, schedules } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      await schedules.removeInstructor(
        z.uuid().parse(request.params.scheduleId),
        z.uuid().parse(request.params.personId),
      );
      response.status(204).end();
    }),
  );

  // ---------- Sessions ----------

  router.get(
    '/orgs/:orgId/sessions',
    route(async (request, response) => {
      const { ctx, sessions } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const query = z
        .strictObject({
          offeringId: z.uuid().optional(),
          scheduleId: z.uuid().optional(),
          from: z.iso.date(),
          to: z.iso.date(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        })
        .parse(request.query);
      response.json({ items: await sessions.list(clean(query)) });
    }),
  );

  router.get(
    '/orgs/:orgId/sessions/:sessionId',
    route(async (request, response) => {
      const { ctx, sessions } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json({
        session: await sessions.get(z.uuid().parse(request.params.sessionId)),
      });
    }),
  );

  router.get(
    '/orgs/:orgId/sessions/:sessionId/roster',
    route(async (request, response) => {
      const { ctx, sessions } = await services(request);
      const sessionId = z.uuid().parse(request.params.sessionId);
      await requireSessionStaffOrInstructor(
        dependencies.database,
        ctx,
        sessionId,
      );
      response.json(
        await withOrg(ctx, (trx) => sessions.roster(trx, sessionId)),
      );
    }),
  );

  router.post(
    '/orgs/:orgId/sessions/:sessionId/substitute',
    route(async (request, response) => {
      write(request);
      const { ctx, sessions } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const body = substituteBodySchema.parse(request.body);
      response.json({
        substitute: await sessions.assignSubstitute(
          z.uuid().parse(request.params.sessionId),
          body.personId,
        ),
      });
    }),
  );

  router.get(
    '/orgs/:orgId/sessions/:sessionId/people/:personId/pickups',
    route(async (request, response) => {
      const { ctx, attendance } = await services(request);
      const sessionId = z.uuid().parse(request.params.sessionId);
      await requireSessionStaffOrInstructor(
        dependencies.database,
        ctx,
        sessionId,
      );
      response.json({
        items: await attendance.pickupPeople(
          sessionId,
          z.uuid().parse(request.params.personId),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/sessions/:sessionId/cancel',
    route(async (request, response) => {
      write(request);
      const { ctx, sessions } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const body = cancelSessionBodySchema.parse(request.body);
      await sessions.cancel(
        z.uuid().parse(request.params.sessionId),
        body.reason ?? null,
      );
      response.status(204).end();
    }),
  );

  // ---------- Attendance ----------

  router.post(
    '/orgs/:orgId/sessions/:sessionId/attendance',
    route(async (request, response) => {
      write(request);
      const { ctx, attendance } = await services(request);
      const sessionId = z.uuid().parse(request.params.sessionId);
      await requireSessionStaffOrInstructor(
        dependencies.database,
        ctx,
        sessionId,
      );
      const body = markAttendanceBodySchema.parse(request.body);
      body.marks.forEach((mark) => attendanceMarkSchema.parse(mark));
      response.json(await attendance.mark(sessionId, body));
    }),
  );

  router.post(
    '/orgs/:orgId/sessions/:sessionId/check-in',
    route(async (request, response) => {
      write(request);
      const { ctx, attendance } = await services(request);
      const sessionId = z.uuid().parse(request.params.sessionId);
      await requireSessionStaffOrInstructor(
        dependencies.database,
        ctx,
        sessionId,
      );
      const body = checkInBodySchema.parse(request.body);
      response.json(await attendance.checkIn(sessionId, body.personId));
    }),
  );

  router.post(
    '/orgs/:orgId/sessions/:sessionId/check-out',
    route(async (request, response) => {
      write(request);
      const { ctx, attendance } = await services(request);
      const sessionId = z.uuid().parse(request.params.sessionId);
      await requireSessionStaffOrInstructor(
        dependencies.database,
        ctx,
        sessionId,
      );
      const body = checkOutBodySchema.parse(request.body);
      response.json(
        await attendance.checkOut(
          sessionId,
          body.personId,
          body.pickedUpByPersonId,
        ),
      );
    }),
  );

  // ---------- Enrollments (staff) ----------

  router.get(
    '/orgs/:orgId/enrollments',
    route(async (request, response) => {
      const { ctx, enrollments } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const query = z
        .strictObject({
          offeringId: z.uuid().optional(),
          personId: z.uuid().optional(),
          householdId: z.uuid().optional(),
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          cursor: z.string().optional(),
        })
        .parse(request.query);
      response.json(await enrollments.list(clean(query)));
    }),
  );

  router.post(
    '/orgs/:orgId/enrollments',
    route(async (request, response) => {
      write(request);
      const { ctx, enrollments } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response
        .status(201)
        .json(
          await enrollments.enroll(
            enrollBodySchema.parse(request.body),
            key(request),
            { staff: true },
          ),
        );
    }),
  );

  router.get(
    '/orgs/:orgId/enrollments/:enrollmentId',
    route(async (request, response) => {
      const { ctx, enrollments } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json({
        enrollment: await enrollments.get(
          z.uuid().parse(request.params.enrollmentId),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/enrollments/:enrollmentId/withdraw',
    route(async (request, response) => {
      write(request);
      const { ctx, enrollments } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json(
        await enrollments.withdraw(
          z.uuid().parse(request.params.enrollmentId),
          withdrawBodySchema.parse(request.body),
          { staff: true },
          key(request),
        ),
      );
    }),
  );

  router.post(
    '/orgs/:orgId/enrollments/:enrollmentId/pause',
    route(async (request, response) => {
      write(request);
      const { ctx, enrollments } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json({
        enrollment: await enrollments.pause(
          z.uuid().parse(request.params.enrollmentId),
          pauseBodySchema.parse(request.body),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/enrollments/:enrollmentId/resume',
    route(async (request, response) => {
      write(request);
      const { ctx, enrollments } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const body = resumeBodySchema.parse(request.body);
      response.json({
        enrollment: await enrollments.resume(
          z.uuid().parse(request.params.enrollmentId),
          body.expectedVersion,
        ),
      });
    }),
  );

  // ---------- Waitlist (staff) ----------

  router.get(
    '/orgs/:orgId/offerings/:offeringId/waitlist',
    route(async (request, response) => {
      const { ctx, enrollments } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json({
        items: await enrollments.waitlist(
          z.uuid().parse(request.params.offeringId),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/waitlist/:entryId/remove',
    route(async (request, response) => {
      write(request);
      const { ctx, enrollments } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      await enrollments.removeFromWaitlist(
        z.uuid().parse(request.params.entryId),
      );
      response.status(204).end();
    }),
  );

  // ---------- Subscriptions (staff) ----------

  router.get(
    '/orgs/:orgId/subscriptions',
    route(async (request, response) => {
      const { ctx, subscriptions } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const query = z
        .strictObject({
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        })
        .parse(request.query);
      response.json({ items: await subscriptions.list(clean(query)) });
    }),
  );

  router.get(
    '/orgs/:orgId/subscriptions/:subscriptionId',
    route(async (request, response) => {
      const { ctx, subscriptions } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json({
        subscription: await subscriptions.get(
          z.uuid().parse(request.params.subscriptionId),
        ),
      });
    }),
  );

  router.patch(
    '/orgs/:orgId/subscriptions/:subscriptionId',
    route(async (request, response) => {
      write(request);
      const { ctx, subscriptions } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json({
        subscription: await subscriptions.update(
          z.uuid().parse(request.params.subscriptionId),
          clean(subscriptionUpdateSchema.parse(request.body)),
        ),
      });
    }),
  );

  // ---------- Skills & levels (staff) ----------

  router.get(
    '/orgs/:orgId/levels',
    route(async (request, response) => {
      const { ctx, skills } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const query = z
        .strictObject({ sportProfileId: z.uuid().optional() })
        .parse(request.query);
      response.json({
        items: await skills.listLevels(query.sportProfileId),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/levels',
    route(async (request, response) => {
      write(request);
      const { ctx, skills } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.status(201).json({
        level: await skills.createLevel(
          skillLevelBodySchema.parse(request.body),
        ),
      });
    }),
  );

  router.get(
    '/orgs/:orgId/levels/:levelId',
    route(async (request, response) => {
      const { ctx, skills } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json({
        level: await skills.getLevel(z.uuid().parse(request.params.levelId)),
      });
    }),
  );

  router.patch(
    '/orgs/:orgId/levels/:levelId',
    route(async (request, response) => {
      write(request);
      const { ctx, skills } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const body = skillLevelBodySchema
        .partial()
        .extend({ expectedVersion: z.int().positive() })
        .parse(request.body);
      response.json({
        level: await skills.updateLevel(
          z.uuid().parse(request.params.levelId),
          clean(body),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/levels/:levelId/skills',
    route(async (request, response) => {
      write(request);
      const { ctx, skills } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.status(201).json({
        skill: await skills.addSkill(
          z.uuid().parse(request.params.levelId),
          skillBodySchema.parse(request.body),
        ),
      });
    }),
  );

  router.patch(
    '/orgs/:orgId/skills/:skillId',
    route(async (request, response) => {
      write(request);
      const { ctx, skills } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const body = skillBodySchema
        .partial()
        .extend({ expectedVersion: z.int().positive() })
        .parse(request.body);
      response.json({
        skill: await skills.updateSkill(
          z.uuid().parse(request.params.skillId),
          clean(body),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/levels/sync',
    route(async (request, response) => {
      write(request);
      const { ctx, skills } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const body = syncLevelsBodySchema.parse(request.body);
      response.json(await skills.syncFromProfile(body.sportProfileId));
    }),
  );

  router.post(
    '/orgs/:orgId/people/:personId/skills',
    route(async (request, response) => {
      write(request);
      const { ctx, skills } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      await skills.recordSkill(
        z.uuid().parse(request.params.personId),
        recordSkillBodySchema.parse(request.body),
      );
      response.status(204).end();
    }),
  );

  router.post(
    '/orgs/:orgId/sessions/:sessionId/skills',
    route(async (request, response) => {
      write(request);
      const { ctx, skills } = await services(request);
      const sessionId = z.uuid().parse(request.params.sessionId);
      await requireSessionStaffOrInstructor(
        dependencies.database,
        ctx,
        sessionId,
      );
      const body = sessionSkillMarksSchema.parse(request.body);
      for (const mark of body.marks) {
        await skills.recordSkill(mark.personId, {
          skillId: mark.skillId,
          status: mark.status,
          note: null,
        });
      }
      response.status(204).end();
    }),
  );

  router.get(
    '/orgs/:orgId/people/:personId/progress',
    route(async (request, response) => {
      const { ctx, skills } = await services(request);
      const personId = z.uuid().parse(request.params.personId);
      try {
        await requireClassStaff(dependencies.database, ctx);
      } catch {
        await requireLinkedPerson(dependencies.database, ctx, personId);
      }
      response.json(await skills.athleteProgress(personId));
    }),
  );

  // ---------- Promotions ----------

  router.get(
    '/orgs/:orgId/promotions',
    route(async (request, response) => {
      const { ctx, promotions } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const query = z
        .strictObject({
          personId: z.uuid().optional(),
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        })
        .parse(request.query);
      response.json({ items: await promotions.list(clean(query)) });
    }),
  );

  router.post(
    '/orgs/:orgId/promotions',
    route(async (request, response) => {
      write(request);
      const { ctx, promotions } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.status(201).json({
        promotion: await promotions.recommend(
          recommendPromotionSchema.parse(request.body),
        ),
      });
    }),
  );

  router.get(
    '/orgs/:orgId/promotions/:promotionId',
    route(async (request, response) => {
      const { ctx, promotions } = await services(request);
      const promotion = await promotions.get(
        z.uuid().parse(request.params.promotionId),
      );
      try {
        await requireClassStaff(dependencies.database, ctx);
      } catch {
        await requireGuardian(dependencies.database, ctx, promotion.personId);
      }
      response.json({ promotion });
    }),
  );

  router.post(
    '/orgs/:orgId/promotions/:promotionId/approve',
    route(async (request, response) => {
      write(request);
      const { ctx, promotions } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const body = versionBodySchema.parse(request.body);
      response.json({
        promotion: await promotions.approve(
          z.uuid().parse(request.params.promotionId),
          body.expectedVersion,
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/promotions/:promotionId/cancel',
    route(async (request, response) => {
      write(request);
      const { ctx, promotions } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      const body = versionBodySchema.parse(request.body);
      response.json({
        promotion: await promotions.cancel(
          z.uuid().parse(request.params.promotionId),
          body.expectedVersion,
        ),
      });
    }),
  );

  router.get(
    '/orgs/:orgId/promotions/:promotionId/certificate.pdf',
    route(async (request, response) => {
      const { ctx, promotions } = await services(request);
      const promotionId = z.uuid().parse(request.params.promotionId);
      const promotion = await promotions.get(promotionId);
      try {
        await requireClassStaff(dependencies.database, ctx);
      } catch {
        await requireGuardian(dependencies.database, ctx, promotion.personId);
      }
      const pdf = await promotions.certificatePdf(promotionId);
      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader(
        'Content-Disposition',
        `attachment; filename="certificate-${promotionId}.pdf"`,
      );
      response.send(Buffer.from(pdf));
    }),
  );

  // ---------- Dashboard ----------

  router.get(
    '/orgs/:orgId/dashboard',
    route(async (request, response) => {
      const { ctx, dashboard } = await services(request);
      await requireClassStaff(dependencies.database, ctx);
      response.json(await dashboard.get());
    }),
  );

  // ---------- Portal (member) routes ----------

  router.get(
    '/orgs/:orgId/me/browse',
    route(async (request, response) => {
      const { ctx, enrollments } = await services(request);
      await requireMember(dependencies.database, ctx);
      const query = z
        .strictObject({
          programId: z.uuid().optional(),
          levelId: z.uuid().optional(),
          day: z.string().optional(),
          ageMonths: z.coerce.number().int().nonnegative().optional(),
          personId: z.uuid().optional(),
        })
        .parse(request.query);
      if (query.personId)
        await requireLinkedPerson(dependencies.database, ctx, query.personId);
      response.json(await enrollments.browse(clean(query)));
    }),
  );

  router.get(
    '/orgs/:orgId/me/enrollments',
    route(async (request, response) => {
      const { ctx, enrollments } = await services(request);
      await requireMember(dependencies.database, ctx);
      const query = z
        .strictObject({
          personId: z.uuid().optional(),
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          cursor: z.string().optional(),
        })
        .parse(request.query);
      response.json(
        await enrollments.list(
          clean({ ...query, accountId: ctx.actor.accountId }),
        ),
      );
    }),
  );

  router.post(
    '/orgs/:orgId/me/enrollments',
    route(async (request, response) => {
      write(request);
      const { ctx, enrollments } = await services(request);
      await requireMember(dependencies.database, ctx);
      const body = portalEnrollBodySchema.parse(request.body);
      await requireLinkedPerson(dependencies.database, ctx, body.personId);
      const householdId = await personHousehold(
        ctx,
        body.personId,
        body.householdId,
      );
      response.status(201).json(
        await enrollments.enroll({ ...body, householdId }, key(request), {
          staff: false,
        }),
      );
    }),
  );

  router.post(
    '/orgs/:orgId/me/enrollments/:enrollmentId/withdraw',
    route(async (request, response) => {
      write(request);
      const { ctx, enrollments } = await services(request);
      await requireMember(dependencies.database, ctx);
      const enrollment = await enrollments.get(
        z.uuid().parse(request.params.enrollmentId),
      );
      await requireLinkedPerson(
        dependencies.database,
        ctx,
        enrollment.personId,
      );
      response.json(
        await enrollments.withdraw(
          enrollment.id,
          withdrawBodySchema.parse(request.body),
          { staff: false },
          key(request),
        ),
      );
    }),
  );

  router.post(
    '/orgs/:orgId/me/enrollments/:enrollmentId/pause',
    route(async (request, response) => {
      write(request);
      const { ctx, enrollments } = await services(request);
      await requireMember(dependencies.database, ctx);
      const enrollment = await enrollments.get(
        z.uuid().parse(request.params.enrollmentId),
      );
      await requireLinkedPerson(
        dependencies.database,
        ctx,
        enrollment.personId,
      );
      response.json({
        enrollment: await enrollments.pause(
          enrollment.id,
          pauseBodySchema.parse(request.body),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/me/enrollments/:enrollmentId/resume',
    route(async (request, response) => {
      write(request);
      const { ctx, enrollments } = await services(request);
      await requireMember(dependencies.database, ctx);
      const enrollment = await enrollments.get(
        z.uuid().parse(request.params.enrollmentId),
      );
      await requireLinkedPerson(
        dependencies.database,
        ctx,
        enrollment.personId,
      );
      const body = resumeBodySchema.parse(request.body);
      response.json({
        enrollment: await enrollments.resume(
          enrollment.id,
          body.expectedVersion,
        ),
      });
    }),
  );

  // ---------- Portal: sessions browse ----------

  router.get(
    '/orgs/:orgId/me/sessions',
    route(async (request, response) => {
      const { ctx, sessions } = await services(request);
      await requireMember(dependencies.database, ctx);
      const query = z
        .strictObject({
          offeringId: z.uuid().optional(),
          from: z.iso.date(),
          to: z.iso.date(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        })
        .parse(request.query);
      response.json({ items: await sessions.list(clean(query)) });
    }),
  );

  // ---------- Portal: make-up credits ----------

  router.get(
    '/orgs/:orgId/me/makeup-credits',
    route(async (request, response) => {
      const { ctx, bookings } = await services(request);
      await requireMember(dependencies.database, ctx);
      const query = z
        .strictObject({
          personId: z.uuid().optional(),
          status: z.string().optional(),
        })
        .parse(request.query);
      response.json({
        items: await bookings.listMakeupCredits(
          clean({ ...query, accountId: ctx.actor.accountId }),
        ),
      });
    }),
  );

  router.get(
    '/orgs/:orgId/me/makeup-credits/:creditId/sessions',
    route(async (request, response) => {
      const { ctx, bookings } = await services(request);
      await requireMember(dependencies.database, ctx);
      const query = z
        .strictObject({
          from: z.iso.date(),
          to: z.iso.date(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        })
        .parse(request.query);
      response.json({
        items: await bookings.eligibleMakeupSessions(
          z.uuid().parse(request.params.creditId),
          ctx.actor.accountId,
          clean(query),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/me/makeup-credits/:creditId/book',
    route(async (request, response) => {
      write(request);
      const { ctx, bookings } = await services(request);
      await requireMember(dependencies.database, ctx);
      const body = bookMakeupBodySchema.parse(request.body);
      const creditId = z.uuid().parse(request.params.creditId);
      if (body.creditId !== creditId)
        throw new ClassesConflictError('Credit id does not match the path');
      response
        .status(201)
        .json(
          await bookings.bookMakeup(
            creditId,
            body.classSessionId,
            ctx.actor.accountId,
          ),
        );
    }),
  );

  // ---------- Portal: drop-in and punch cards ----------

  router.post(
    '/orgs/:orgId/me/drop-in',
    route(async (request, response) => {
      write(request);
      const { ctx, bookings } = await services(request);
      await requireMember(dependencies.database, ctx);
      const body = portalDropInBodySchema.parse(request.body);
      await requireLinkedPerson(dependencies.database, ctx, body.personId);
      const householdId = await personHousehold(
        ctx,
        body.personId,
        body.householdId,
      );
      response
        .status(201)
        .json(
          await bookings.bookDropIn(
            body.classSessionId,
            body.personId,
            householdId,
            key(request),
          ),
        );
    }),
  );

  router.get(
    '/orgs/:orgId/me/punch-cards',
    route(async (request, response) => {
      const { ctx, bookings } = await services(request);
      await requireMember(dependencies.database, ctx);
      const query = z
        .strictObject({ personId: z.uuid().optional() })
        .parse(request.query);
      response.json({
        items: await bookings.listPunchCards(
          clean({ ...query, accountId: ctx.actor.accountId }),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/me/punch-cards',
    route(async (request, response) => {
      write(request);
      const { ctx, bookings } = await services(request);
      await requireMember(dependencies.database, ctx);
      const body = portalPunchCardPurchaseSchema.parse(request.body);
      await requireLinkedPerson(dependencies.database, ctx, body.personId);
      const householdId = await personHousehold(
        ctx,
        body.personId,
        body.householdId,
      );
      response
        .status(201)
        .json(
          await bookings.purchasePunchCard(
            body.classOfferingId,
            body.personId,
            householdId,
            key(request),
          ),
        );
    }),
  );

  router.post(
    '/orgs/:orgId/me/punch-cards/:punchCardId/book',
    route(async (request, response) => {
      write(request);
      const { ctx, bookings } = await services(request);
      await requireMember(dependencies.database, ctx);
      const body = z
        .strictObject({ classSessionId: z.uuid() })
        .parse(request.body);
      response
        .status(201)
        .json(
          await bookings.bookPunchCard(
            body.classSessionId,
            z.uuid().parse(request.params.punchCardId),
            ctx.actor.accountId,
          ),
        );
    }),
  );

  router.post(
    '/orgs/:orgId/me/bookings/:bookingId/cancel',
    route(async (request, response) => {
      write(request);
      const { ctx, bookings } = await services(request);
      await requireMember(dependencies.database, ctx);
      await bookings.cancelBooking(
        z.uuid().parse(request.params.bookingId),
        ctx.actor.accountId,
      );
      response.status(204).end();
    }),
  );

  // ---------- Portal: subscriptions ----------

  router.get(
    '/orgs/:orgId/me/subscriptions',
    route(async (request, response) => {
      const { ctx, subscriptions } = await services(request);
      await requireMember(dependencies.database, ctx);
      response.json({
        items: await subscriptions.list({
          accountId: ctx.actor.accountId,
          limit: 200,
        }),
      });
    }),
  );

  router.patch(
    '/orgs/:orgId/me/subscriptions/:subscriptionId',
    route(async (request, response) => {
      write(request);
      const { ctx, subscriptions } = await services(request);
      await requireMember(dependencies.database, ctx);
      const existing = await subscriptions.get(
        z.uuid().parse(request.params.subscriptionId),
      );
      if (existing.accountId !== ctx.actor.accountId)
        throw new ClassesNotFoundError('Subscription not found');
      const body = subscriptionUpdateSchema.parse(request.body);
      response.json({
        subscription: await subscriptions.update(
          existing.id,
          clean({
            paymentMethodId: body.paymentMethodId,
            autopayConsent: body.autopayConsent,
            expectedVersion: body.expectedVersion,
          }),
        ),
      });
    }),
  );

  // ---------- Portal: waitlist offers ----------

  router.get(
    '/orgs/:orgId/me/waitlist',
    route(async (request, response) => {
      const { ctx, enrollments } = await services(request);
      await requireMember(dependencies.database, ctx);
      const query = z
        .strictObject({ personId: z.uuid().optional() })
        .parse(request.query);
      if (query.personId)
        await requireLinkedPerson(dependencies.database, ctx, query.personId);
      response.json(
        waitlistListSchema.parse({
          items: await enrollments.waitlistForAccount(
            ctx.actor.accountId,
            query.personId,
          ),
        }),
      );
    }),
  );

  router.post(
    '/orgs/:orgId/me/waitlist/:entryId/accept',
    route(async (request, response) => {
      write(request);
      const { ctx, enrollments } = await services(request);
      await requireMember(dependencies.database, ctx);
      response
        .status(201)
        .json(
          await enrollments.acceptWaitlistOffer(
            z.uuid().parse(request.params.entryId),
            waitlistAcceptBodySchema.parse(request.body),
            key(request),
            { staff: false },
          ),
        );
    }),
  );

  router.post(
    '/orgs/:orgId/me/waitlist/:entryId/decline',
    route(async (request, response) => {
      write(request);
      const { ctx, enrollments } = await services(request);
      await requireMember(dependencies.database, ctx);
      await enrollments.declineWaitlistOffer(
        z.uuid().parse(request.params.entryId),
        ctx.actor.accountId,
      );
      response.status(204).end();
    }),
  );

  // ---------- Portal: promotions ----------

  router.get(
    '/orgs/:orgId/me/promotions',
    route(async (request, response) => {
      const { ctx, promotions } = await services(request);
      await requireMember(dependencies.database, ctx);
      response.json({
        items: await promotions.list({
          accountId: ctx.actor.accountId,
          limit: 200,
        }),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/me/promotions/:promotionId/confirm',
    route(async (request, response) => {
      write(request);
      const { ctx, promotions } = await services(request);
      await requireMember(dependencies.database, ctx);
      const promotion = await promotions.get(
        z.uuid().parse(request.params.promotionId),
      );
      await requireGuardian(dependencies.database, ctx, promotion.personId);
      response.json({
        promotion: await promotions.confirm(
          promotion.id,
          clean(promotionDecisionBodySchema.parse(request.body)),
          key(request),
        ),
      });
    }),
  );

  router.post(
    '/orgs/:orgId/me/promotions/:promotionId/decline',
    route(async (request, response) => {
      write(request);
      const { ctx, promotions } = await services(request);
      await requireMember(dependencies.database, ctx);
      const promotion = await promotions.get(
        z.uuid().parse(request.params.promotionId),
      );
      await requireGuardian(dependencies.database, ctx, promotion.personId);
      const body = versionBodySchema.parse(request.body);
      response.json({
        promotion: await promotions.decline(promotion.id, body.expectedVersion),
      });
    }),
  );

  return router;
}
