import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgContext } from '../../db/withOrg';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';
import { mutationOriginIsValid, sendScheduleError } from '../scheduling/http';

import {
  contestDetail,
  confirmContestResult,
  createContest,
  assignMeetParticipants,
  disputeContestResult,
  getProgramStatSettings,
  listContestResults,
  listPersonPersonalBests,
  listProgramStatLeaders,
  listTeamStats,
  liveContestPublic,
  submitContestResult,
  updateProgramStatSettings,
} from './service';

const id = z.uuid();
const scoreEntrySchema = z.strictObject({
  participantId: id,
  value: z.number().nonnegative().optional(),
  place: z.number().int().positive().optional(),
  attempts: z.array(z.number().nonnegative()).optional(),
  status: z.enum(['ok', 'dq', 'dnf', 'dns']).optional(),
  relay: z.boolean().optional(),
  sheets: z
    .array(
      z.strictObject({
        judgeId: z.string().min(1).max(120),
        components: z.record(z.string(), z.number()),
      }),
    )
    .optional(),
});
const resultSchema = z.strictObject({
  home: z.number().nonnegative().optional(),
  away: z.number().nonnegative().optional(),
  periods: z
    .array(
      z.strictObject({
        home: z.number().int().nonnegative(),
        away: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  shootoutWinner: z.enum(['home', 'away']).optional(),
  forfeitBy: z.enum(['home', 'away']).optional(),
  forfeitScore: z
    .strictObject({
      winner: z.number().int().nonnegative(),
      loser: z.number().int().nonnegative(),
    })
    .optional(),
  sets: z
    .array(
      z.strictObject({
        home: z.number().int().nonnegative(),
        away: z.number().int().nonnegative(),
        tiebreakWinner: z.enum(['home', 'away']).optional(),
      }),
    )
    .optional(),
  winner: z.enum(['home', 'away']).optional(),
  method: z.string().optional(),
  entries: z.array(scoreEntrySchema).optional(),
  stats: z
    .array(
      z.strictObject({
        participantId: id,
        statKey: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
        value: z.number().nonnegative(),
      }),
    )
    .optional(),
  cards: z
    .array(
      z.strictObject({
        personId: id,
        type: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
        description: z.string().max(1000).optional(),
      }),
    )
    .optional(),
  abandoned: z.boolean().optional(),
});

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

export function createContestsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));
  router.get('/orgs/:orgId/events/:eventId/results', async (req, res) => {
    try {
      res.json(
        await listContestResults(
          await contextFor(dependencies, req),
          id.parse(req.params.eventId),
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/orgs/:orgId/events/:eventId/contests', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({
          formatIndex: z.number().int().nonnegative(),
          stage: z.enum([
            'regular',
            'pool',
            'playoff',
            'championship',
            'consolation',
            'friendly',
            'exhibition',
          ]),
          countsForStandings: z.boolean(),
        })
        .parse(req.body);
      res
        .status(201)
        .json(
          await createContest(
            await contextFor(dependencies, req),
            id.parse(req.params.eventId),
            input,
          ),
        );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/orgs/:orgId/contests/:contestId', async (req, res) => {
    try {
      res.json(
        await contestDetail(
          await contextFor(dependencies, req),
          id.parse(req.params.contestId),
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.put(
    '/orgs/:orgId/contests/:contestId/meet-assignments',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            expectedVersion: z.number().int().positive(),
            assignments: z
              .array(
                z.strictObject({
                  participantId: id,
                  seed: z.number().int().positive(),
                  heat: z.number().int().positive(),
                  lane: z.number().int().positive(),
                }),
              )
              .min(1)
              .max(1024),
          })
          .parse(req.body);
        res.json(
          await assignMeetParticipants(
            await contextFor(dependencies, req),
            id.parse(req.params.contestId),
            input,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.post('/orgs/:orgId/contests/:contestId/results', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({
          expectedVersion: z.number().int().positive(),
          finalize: z.boolean(),
          correctionReason: z.string().trim().min(1).max(1000).optional(),
          result: resultSchema,
        })
        .parse(req.body);
      res.json(
        await submitContestResult(
          await contextFor(dependencies, req),
          id.parse(req.params.contestId),
          input as unknown as Parameters<typeof submitContestResult>[2],
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/orgs/:orgId/contests/:contestId/confirm', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({ expectedVersion: z.number().int().positive() })
        .parse(req.body);
      res.json(
        await confirmContestResult(
          await contextFor(dependencies, req),
          id.parse(req.params.contestId),
          input.expectedVersion,
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/orgs/:orgId/contests/:contestId/disputes', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({
          expectedVersion: z.number().int().positive(),
          reason: z.string().trim().min(1).max(1000),
        })
        .parse(req.body);
      res.json(
        await disputeContestResult(
          await contextFor(dependencies, req),
          id.parse(req.params.contestId),
          input,
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/orgs/:orgId/teams/:teamSeasonId/stats', async (req, res) => {
    try {
      const query = req.query as Record<string, unknown>;
      res.json(
        await listTeamStats(await contextFor(dependencies, req), {
          teamSeasonId: id.parse(req.params.teamSeasonId),
          ...(query.statKey === undefined
            ? {}
            : { statKey: z.string().parse(query.statKey) }),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get(
    '/orgs/:orgId/programs/:programId/stats/settings',
    async (req, res) => {
      try {
        res.json(
          await getProgramStatSettings(
            await contextFor(dependencies, req),
            id.parse(req.params.programId),
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.put(
    '/orgs/:orgId/programs/:programId/stats/settings',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            expectedVersion: z.number().int().positive(),
            enabledStatKeys: z
              .array(z.string().regex(/^[a-z0-9][a-z0-9_]*$/))
              .max(200),
          })
          .parse(req.body);
        res.json(
          await updateProgramStatSettings(
            await contextFor(dependencies, req),
            id.parse(req.params.programId),
            input,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.get(
    '/orgs/:orgId/programs/:programId/stats/leaders',
    async (req, res) => {
      try {
        const query = req.query as Record<string, unknown>;
        res.json(
          await listProgramStatLeaders(await contextFor(dependencies, req), {
            programId: id.parse(req.params.programId),
            ...(query.divisionId === undefined
              ? {}
              : { divisionId: id.parse(query.divisionId) }),
          }),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.get(
    '/orgs/:orgId/people/:personId/personal-bests',
    async (req, res) => {
      try {
        res.json(
          await listPersonPersonalBests(
            await contextFor(dependencies, req),
            id.parse(req.params.personId),
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.get(
    '/public/orgs/:orgSlug/contests/:contestId/live',
    async (req, res) => {
      try {
        res.setHeader(
          'Cache-Control',
          'public, max-age=10, stale-while-revalidate=30',
        );
        res.json(
          await liveContestPublic(
            z.string().min(1).parse(req.params.orgSlug),
            id.parse(req.params.contestId),
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  return router;
}
