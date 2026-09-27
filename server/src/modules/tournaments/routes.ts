import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgContext } from '../../db/withOrg';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';
import { mutationOriginIsValid, sendScheduleError } from '../scheduling/http';

import {
  checkInTournamentTeam,
  createBracket,
  createTournamentPool,
  generateBracket,
  getBracket,
  getPublicBracketBySlug,
  listBrackets,
  seedFromPools,
  setBracketContest,
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

const entrantSchema = z
  .strictObject({
    teamSeasonId: id.optional(),
    externalTeamId: id.optional(),
    seed: z.number().int().positive().optional(),
  })
  .refine(
    (entry) => Boolean(entry.teamSeasonId) !== Boolean(entry.externalTeamId),
    'Choose one team type.',
  );
const bracketSchema = z.strictObject({
  programId: id,
  divisionId: id.optional(),
  name: z.string().trim().min(1).max(160),
  type: z.enum([
    'single_elim',
    'double_elim',
    'round_robin_pools',
    'pools_to_bracket',
    'consolation',
    'ladder',
  ]),
  seedingSource: z.enum(['manual', 'standings', 'pool_results', 'random']),
  thirdPlace: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  entries: z.array(entrantSchema).min(1).max(1024),
});

export function createTournamentsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));
  router.get('/orgs/:orgId/programs/:programId', async (req, res) => {
    try {
      res.json({
        items: await listBrackets(
          await contextFor(dependencies, req),
          id.parse(req.params.programId),
        ),
      });
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/orgs/:orgId/brackets', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = bracketSchema.parse(req.body);
      res.status(201).json(
        await createBracket(await contextFor(dependencies, req), {
          programId: input.programId,
          name: input.name,
          type: input.type,
          seedingSource: input.seedingSource,
          entries: input.entries.map((entry) => ({
            ...(entry.teamSeasonId ? { teamSeasonId: entry.teamSeasonId } : {}),
            ...(entry.externalTeamId
              ? { externalTeamId: entry.externalTeamId }
              : {}),
            ...(entry.seed ? { seed: entry.seed } : {}),
          })),
          ...(input.divisionId ? { divisionId: input.divisionId } : {}),
          ...(input.thirdPlace === undefined
            ? {}
            : { thirdPlace: input.thirdPlace }),
          ...(input.config ? { config: input.config } : {}),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/orgs/:orgId/brackets/:bracketId', async (req, res) => {
    try {
      res.json(
        await getBracket(
          await contextFor(dependencies, req),
          id.parse(req.params.bracketId),
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/orgs/:orgId/brackets/:bracketId/generate', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({ expectedVersion: z.number().int().positive() })
        .parse(req.body);
      res.json(
        await generateBracket(
          await contextFor(dependencies, req),
          id.parse(req.params.bracketId),
          input.expectedVersion,
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post(
    '/orgs/:orgId/brackets/:bracketId/entries/:entryId/check-in',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({ expectedVersion: z.number().int().positive() })
          .parse(req.body);
        res.json(
          await checkInTournamentTeam(
            await contextFor(dependencies, req),
            id.parse(req.params.bracketId),
            id.parse(req.params.entryId),
            input.expectedVersion,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/brackets/:bracketId/matches/:matchId/contest',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            contestId: id,
            expectedVersion: z.number().int().positive(),
          })
          .parse(req.body);
        res.json(
          await setBracketContest(
            await contextFor(dependencies, req),
            id.parse(req.params.bracketId),
            id.parse(req.params.matchId),
            input.contestId,
            input.expectedVersion,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.post('/orgs/:orgId/brackets/:bracketId/pools', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({
          name: z.string().trim().min(1).max(100),
          members: z
            .array(
              z
                .strictObject({
                  teamSeasonId: id.optional(),
                  externalTeamId: id.optional(),
                })
                .refine(
                  (member) =>
                    Boolean(member.teamSeasonId) !==
                    Boolean(member.externalTeamId),
                  'Choose one team type.',
                ),
            )
            .min(2),
        })
        .parse(req.body);
      res.status(201).json(
        await createTournamentPool(
          await contextFor(dependencies, req),
          id.parse(req.params.bracketId),
          input.name,
          input.members.map((member) => ({
            ...(member.teamSeasonId
              ? { teamSeasonId: member.teamSeasonId }
              : {}),
            ...(member.externalTeamId
              ? { externalTeamId: member.externalTeamId }
              : {}),
          })),
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/orgs/:orgId/brackets/pool-seeds', (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({
          mode: z.enum(['cross_pool', 'overall']),
          entrants: z
            .array(
              z.strictObject({
                id,
                seed: z.number().int().positive(),
                pool: z.string().optional(),
                poolRank: z.number().int().positive().optional(),
                pointsPerGame: z.number().optional(),
              }),
            )
            .min(2),
        })
        .parse(req.body);
      const entrants = input.entrants.map((entry) => ({
        id: entry.id,
        seed: entry.seed,
        ...(entry.pool ? { pool: entry.pool } : {}),
        ...(entry.poolRank === undefined ? {} : { poolRank: entry.poolRank }),
        ...(entry.pointsPerGame === undefined
          ? {}
          : { pointsPerGame: entry.pointsPerGame }),
      }));
      res.json({ entrants: seedFromPools(entrants, input.mode) });
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/public/orgs/:orgSlug/brackets/:bracketId', async (req, res) => {
    try {
      res.setHeader(
        'Cache-Control',
        'public, max-age=15, stale-while-revalidate=60',
      );
      res.json(
        await getPublicBracketBySlug(
          z.string().min(1).parse(req.params.orgSlug),
          id.parse(req.params.bracketId),
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  return router;
}
