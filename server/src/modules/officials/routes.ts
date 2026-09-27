import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgContext } from '../../db/withOrg';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';
import { mutationOriginIsValid, sendScheduleError } from '../scheduling/http';

import {
  approvePayBatch,
  assignOfficial,
  assignmentBoard,
  confirmOfficialAssignment,
  createPayBatch,
  exportOfficialsCsv,
  listMyAssignments,
  listOfficials,
  markOfficialNoShow,
  markPayBatchPaid,
  respondToAssignment,
  saveOfficialProfile,
  setOfficialAvailability,
  selfAssign,
  submitGameReport,
  officialYearlyTotals,
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

const payRate = z.union([
  z.number().int().nonnegative(),
  z.strictObject({ feeCents: z.number().int().nonnegative() }),
]);

export function createOfficialsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));
  router.get('/orgs/:orgId/profiles', async (req, res) => {
    try {
      const query = req.query as Record<string, unknown>;
      res.json({
        items: await listOfficials(await contextFor(dependencies, req), {
          ...(query.programId ? { programId: id.parse(query.programId) } : {}),
          ...(query.active === 'true'
            ? { active: true }
            : query.active === 'false'
              ? { active: false }
              : {}),
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });
  router.put('/orgs/:orgId/profiles/:personId', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({
          grade: z.string().max(80).nullable().optional(),
          level: z.string().max(80).nullable().optional(),
          sports: z.array(id),
          maxGamesPerDay: z.number().int().positive().nullable().optional(),
          homeArea: z.string().max(160).nullable().optional(),
          homeLat: z.number().min(-90).max(90).nullable().optional(),
          homeLng: z.number().min(-180).max(180).nullable().optional(),
          travelRadiusKm: z.number().int().nonnegative().nullable().optional(),
          payRates: z.record(z.string(), payRate),
          active: z.boolean(),
          expectedVersion: z.number().int().positive().optional(),
        })
        .parse(req.body);
      res.json(
        await saveOfficialProfile(await contextFor(dependencies, req), {
          personId: id.parse(req.params.personId),
          sports: input.sports,
          payRates: input.payRates,
          active: input.active,
          ...(input.grade === undefined ? {} : { grade: input.grade }),
          ...(input.level === undefined ? {} : { level: input.level }),
          ...(input.maxGamesPerDay === undefined
            ? {}
            : { maxGamesPerDay: input.maxGamesPerDay }),
          ...(input.homeArea === undefined ? {} : { homeArea: input.homeArea }),
          ...(input.homeLat === undefined ? {} : { homeLat: input.homeLat }),
          ...(input.homeLng === undefined ? {} : { homeLng: input.homeLng }),
          ...(input.travelRadiusKm === undefined
            ? {}
            : { travelRadiusKm: input.travelRadiusKm }),
          ...(input.expectedVersion === undefined
            ? {}
            : { expectedVersion: input.expectedVersion }),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/orgs/:orgId/availability', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({
          personId: id.optional(),
          available: z.boolean(),
          recurrence: z.unknown().optional(),
          startsOn: z.iso.date().nullable().optional(),
          endsOn: z.iso.date().nullable().optional(),
        })
        .parse(req.body);
      res.status(201).json(
        await setOfficialAvailability(await contextFor(dependencies, req), {
          ...(input.personId ? { personId: input.personId } : {}),
          available: input.available,
          ...(input.recurrence ? { recurrence: input.recurrence } : {}),
          ...(input.startsOn !== undefined ? { startsOn: input.startsOn } : {}),
          ...(input.endsOn !== undefined ? { endsOn: input.endsOn } : {}),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/orgs/:orgId/assignment-board', async (req, res) => {
    try {
      const q = req.query as Record<string, unknown>;
      const input = z
        .strictObject({
          from: z.iso.datetime({ offset: true }),
          to: z.iso.datetime({ offset: true }),
          programId: id.optional(),
        })
        .parse({
          from: q.from,
          to: q.to,
          ...(q.programId ? { programId: q.programId } : {}),
        });
      if (new Date(input.from) >= new Date(input.to))
        throw new RangeError('End must follow start.');
      res.json(
        await assignmentBoard(await contextFor(dependencies, req), {
          from: new Date(input.from),
          to: new Date(input.to),
          ...(input.programId ? { programId: input.programId } : {}),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/orgs/:orgId/assignments', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({
          contestId: id,
          personId: id,
          positionKey: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
          mileageCents: z.number().int().nonnegative().optional(),
        })
        .parse(req.body);
      res.status(201).json(
        await assignOfficial(await contextFor(dependencies, req), {
          contestId: input.contestId,
          personId: input.personId,
          positionKey: input.positionKey,
          ...(input.mileageCents === undefined
            ? {}
            : { mileageCents: input.mileageCents }),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/orgs/:orgId/me/assignments', async (req, res) => {
    try {
      res.json({
        items: await listMyAssignments(await contextFor(dependencies, req)),
      });
    } catch (error) {
      fail(res, error);
    }
  });
  router.post(
    '/orgs/:orgId/me/contests/:contestId/self-assign',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            positionKey: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
          })
          .parse(req.body);
        res
          .status(201)
          .json(
            await selfAssign(
              await contextFor(dependencies, req),
              id.parse(req.params.contestId),
              input.positionKey,
            ),
          );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/assignments/:assignmentId/respond',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            expectedVersion: z.number().int().positive(),
            response: z.enum(['accepted', 'declined']),
          })
          .parse(req.body);
        res.json(
          await respondToAssignment(
            await contextFor(dependencies, req),
            id.parse(req.params.assignmentId),
            input.expectedVersion,
            input.response,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/assignments/:assignmentId/confirm',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({ expectedVersion: z.number().int().positive() })
          .parse(req.body);
        res.json(
          await confirmOfficialAssignment(
            await contextFor(dependencies, req),
            id.parse(req.params.assignmentId),
            input.expectedVersion,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/assignments/:assignmentId/no-show',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({ expectedVersion: z.number().int().positive() })
          .parse(req.body);
        res.json(
          await markOfficialNoShow(
            await contextFor(dependencies, req),
            id.parse(req.params.assignmentId),
            input.expectedVersion,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.post('/orgs/:orgId/contests/:contestId/reports', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({
          bodyHtml: z.string().trim().min(1).max(20000),
          incidents: z
            .array(
              z.strictObject({
                kind: z.string().trim().min(1).max(80),
                description: z.string().trim().min(1).max(1000),
              }),
            )
            .max(100),
        })
        .parse(req.body);
      res
        .status(201)
        .json(
          await submitGameReport(
            await contextFor(dependencies, req),
            id.parse(req.params.contestId),
            input,
          ),
        );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/orgs/:orgId/pay-batches', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({ periodStart: z.iso.date(), periodEnd: z.iso.date() })
        .parse(req.body);
      res
        .status(201)
        .json(await createPayBatch(await contextFor(dependencies, req), input));
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/orgs/:orgId/pay-batches/:batchId/approve', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({ expectedVersion: z.number().int().positive() })
        .parse(req.body);
      res.json(
        await approvePayBatch(
          await contextFor(dependencies, req),
          id.parse(req.params.batchId),
          input.expectedVersion,
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post(
    '/orgs/:orgId/pay-batches/:batchId/record-payment',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            expectedVersion: z.number().int().positive(),
            paidVia: z.enum(['external', 'check', 'other']),
            reference: z.string().trim().max(200).optional(),
          })
          .parse(req.body);
        res.json(
          await markPayBatchPaid(
            await contextFor(dependencies, req),
            id.parse(req.params.batchId),
            input.expectedVersion,
            {
              paidVia: input.paidVia,
              ...(input.reference ? { reference: input.reference } : {}),
            },
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.get('/orgs/:orgId/payroll/yearly-totals', async (req, res) => {
    try {
      const query = req.query as Record<string, unknown>;
      const year = z
        .number()
        .int()
        .min(2000)
        .max(2200)
        .parse(Number(query.year));
      res.json({
        items: await officialYearlyTotals(
          await contextFor(dependencies, req),
          year,
        ),
      });
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/orgs/:orgId/payroll/yearly-totals.csv', async (req, res) => {
    try {
      const query = req.query as Record<string, unknown>;
      const year = z
        .number()
        .int()
        .min(2000)
        .max(2200)
        .parse(Number(query.year));
      res
        .type('text/csv')
        .attachment(`official-pay-${String(year)}.csv`)
        .send(
          await exportOfficialsCsv(await contextFor(dependencies, req), year),
        );
    } catch (error) {
      fail(res, error);
    }
  });
  return router;
}
