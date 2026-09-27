import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgContext } from '../../db/withOrg';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';
import { mutationOriginIsValid, sendScheduleError } from '../scheduling/http';

import {
  attendanceReport,
  checkOutAthlete,
  coachGameDay,
  listEventAttendance,
  rsvpForChild,
  saveLineup,
  setAttendance,
} from './service';

const id = z.uuid();
async function contextFor(
  dependencies: AuthDependencies,
  request: Request,
): Promise<OrgContext> {
  const session = await requireSession(dependencies, request);
  return {
    orgId: id.parse(request.params.orgId),
    actor: { accountId: session.accountId },
  };
}
function mutate(dependencies: AuthDependencies, request: Request): void {
  if (!mutationOriginIsValid(request, dependencies.appUrl))
    throw Object.assign(new Error('Request origin could not be verified.'), {
      status: 403,
    });
}
function fail(response: Response, error: unknown): void {
  sendScheduleError(response, error);
}

export function createAttendanceRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));
  router.get('/orgs/:orgId/events/:eventId', async (req, res) => {
    try {
      res.json(
        await listEventAttendance(
          await contextFor(dependencies, req),
          id.parse(req.params.eventId),
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/orgs/:orgId/events/:eventId/game-day', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(
        await coachGameDay(
          await contextFor(dependencies, req),
          id.parse(req.params.eventId),
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.put(
    '/orgs/:orgId/events/:eventId/people/:personId/rsvp',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({ rsvp: z.enum(['yes', 'no', 'maybe', 'none']) })
          .parse(req.body);
        res.json(
          await rsvpForChild(
            await contextFor(dependencies, req),
            id.parse(req.params.eventId),
            id.parse(req.params.personId),
            input.rsvp,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.patch(
    '/orgs/:orgId/events/:eventId/people/:personId/attendance',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            status: z.enum(['present', 'absent', 'late', 'excused', 'unknown']),
            expectedVersion: z.number().int().nonnegative(),
            checkIn: z.boolean().optional(),
          })
          .parse(req.body);
        res.json(
          await setAttendance(
            await contextFor(dependencies, req),
            id.parse(req.params.eventId),
            id.parse(req.params.personId),
            {
              status: input.status,
              expectedVersion: input.expectedVersion,
              ...(input.checkIn === undefined
                ? {}
                : { checkIn: input.checkIn }),
            },
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/events/:eventId/people/:personId/check-out',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            pickupPersonId: id,
            expectedVersion: z.number().int().positive(),
          })
          .parse(req.body);
        res.json(
          await checkOutAthlete(
            await contextFor(dependencies, req),
            id.parse(req.params.eventId),
            id.parse(req.params.personId),
            input.pickupPersonId,
            input.expectedVersion,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.put(
    '/orgs/:orgId/contests/:contestId/teams/:teamSeasonId/lineup',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            expectedVersion: z.number().int().nonnegative().optional(),
            entries: z
              .array(
                z.strictObject({
                  personId: id,
                  position: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
                  order: z.number().int().nonnegative().optional(),
                }),
              )
              .max(200),
          })
          .parse(req.body);
        const entries = input.entries.map((entry) => ({
          personId: entry.personId,
          position: entry.position,
          ...(entry.order === undefined ? {} : { order: entry.order }),
        }));
        res.json(
          await saveLineup(
            await contextFor(dependencies, req),
            id.parse(req.params.contestId),
            id.parse(req.params.teamSeasonId),
            entries,
            input.expectedVersion,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.get('/orgs/:orgId/reports', async (req, res) => {
    try {
      const query = req.query as Record<string, unknown>;
      const input = z
        .strictObject({
          from: z.iso.datetime({ offset: true }),
          to: z.iso.datetime({ offset: true }),
          teamSeasonId: id.optional(),
        })
        .parse({
          from: query.from,
          to: query.to,
          ...(query.teamSeasonId ? { teamSeasonId: query.teamSeasonId } : {}),
        });
      if (new Date(input.from) >= new Date(input.to))
        throw new RangeError('Report end must follow its start.');
      res.json({
        items: await attendanceReport(await contextFor(dependencies, req), {
          from: new Date(input.from),
          to: new Date(input.to),
          ...(input.teamSeasonId ? { teamSeasonId: input.teamSeasonId } : {}),
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });
  return router;
}
