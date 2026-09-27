import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgContext } from '../../db/withOrg';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';
import { mutationOriginIsValid, sendScheduleError } from '../scheduling/http';

import {
  archiveSeason,
  changeSeasonSurveyStatus,
  createSeasonAward,
  createSeasonSurvey,
  getSeasonSurveyResults,
  getPriorSeasonPlayerRatings,
  listFamilySeasonSurveys,
  listSeasonAwards,
  listSeasonSurveys,
  saveCoachPlayerRating,
  submitSeasonSurveyResponse,
} from './season-end';
import {
  configureStandings,
  getPublicStandingsBySlug,
  getStandings,
  refreshStandings,
} from './service';
import type { ConfigScope } from './service';

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

export function createStandingsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
  const scopeFor = (
    field: 'programId' | 'divisionId',
    value: string,
  ): ConfigScope =>
    field === 'programId' ? { programId: value } : { divisionId: value };
  const scopeId = (request: Request, field: 'programId' | 'divisionId') =>
    id.parse(
      field === 'programId'
        ? request.params.programId
        : request.params.divisionId,
    );
  const scopeHandlers = (field: 'programId' | 'divisionId') => ({
    read: async (req: Request, res: Response) => {
      try {
        res.json(
          await getStandings(
            await contextFor(dependencies, req),
            scopeFor(field, scopeId(req, field)),
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
    refresh: async (req: Request, res: Response) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({ manualOrder: z.array(id).optional() })
          .parse(req.body);
        res.json(
          await refreshStandings(
            await contextFor(dependencies, req),
            scopeFor(field, scopeId(req, field)),
            input.manualOrder,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
    configure: async (req: Request, res: Response) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            config: z.unknown(),
            expectedVersion: z.number().int().positive().optional(),
          })
          .parse(req.body);
        res.json(
          await configureStandings(
            await contextFor(dependencies, req),
            scopeFor(field, scopeId(req, field)),
            input.config,
            input.expectedVersion,
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  });
  const programHandlers = scopeHandlers('programId');
  router.get(
    '/orgs/:orgId/programs/:programId/standings',
    programHandlers.read,
  );
  router.post(
    '/orgs/:orgId/programs/:programId/standings/refresh',
    programHandlers.refresh,
  );
  router.put(
    '/orgs/:orgId/programs/:programId/standings/config',
    programHandlers.configure,
  );
  const divisionHandlers = scopeHandlers('divisionId');
  router.get(
    '/orgs/:orgId/divisions/:divisionId/standings',
    divisionHandlers.read,
  );
  router.post(
    '/orgs/:orgId/divisions/:divisionId/standings/refresh',
    divisionHandlers.refresh,
  );
  router.put(
    '/orgs/:orgId/divisions/:divisionId/standings/config',
    divisionHandlers.configure,
  );
  router.get('/orgs/:orgId/season-surveys', async (req, res) => {
    try {
      res.json({
        items: await listFamilySeasonSurveys(
          await contextFor(dependencies, req),
        ),
      });
    } catch (error) {
      fail(res, error);
    }
  });
  router.get(
    '/orgs/:orgId/programs/:programId/season-surveys',
    async (req, res) => {
      try {
        res.json({
          items: await listSeasonSurveys(
            await contextFor(dependencies, req),
            id.parse(req.params.programId),
          ),
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/programs/:programId/season-surveys',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            title: z.string().trim().min(1).max(200),
            locale: z.enum(['en', 'es']).optional(),
            opensAt: z.iso.datetime({ offset: true }).optional(),
            closesAt: z.iso.datetime({ offset: true }).optional(),
          })
          .parse(req.body);
        res.status(201).json(
          await createSeasonSurvey(
            await contextFor(dependencies, req),
            id.parse(req.params.programId),
            {
              title: input.title,
              ...(input.locale ? { locale: input.locale } : {}),
              ...(input.opensAt ? { opensAt: new Date(input.opensAt) } : {}),
              ...(input.closesAt ? { closesAt: new Date(input.closesAt) } : {}),
            },
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.patch('/orgs/:orgId/season-surveys/:campaignId', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({
          status: z.enum(['open', 'closed', 'archived']),
          expectedVersion: z.number().int().positive(),
        })
        .parse(req.body);
      res.json(
        await changeSeasonSurveyStatus(
          await contextFor(dependencies, req),
          id.parse(req.params.campaignId),
          input.expectedVersion,
          input.status,
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post(
    '/orgs/:orgId/season-surveys/:campaignId/responses',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            nps: z.number().int().min(0).max(10),
            responseText: z.string().trim().max(4000).optional(),
          })
          .parse(req.body);
        res.status(201).json(
          await submitSeasonSurveyResponse(
            await contextFor(dependencies, req),
            id.parse(req.params.campaignId),
            {
              nps: input.nps,
              ...(input.responseText
                ? { responseText: input.responseText }
                : {}),
            },
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.get(
    '/orgs/:orgId/season-surveys/:campaignId/results',
    async (req, res) => {
      try {
        res.json(
          await getSeasonSurveyResults(
            await contextFor(dependencies, req),
            id.parse(req.params.campaignId),
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.put(
    '/orgs/:orgId/team-seasons/:teamSeasonId/player-ratings',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            personId: id,
            rating: z.number().int().min(1).max(5),
            returningNextSeason: z.boolean().optional(),
            notes: z.string().trim().max(1000).optional(),
            expectedVersion: z.number().int().positive().optional(),
          })
          .parse(req.body);
        res.json(
          await saveCoachPlayerRating(await contextFor(dependencies, req), {
            teamSeasonId: id.parse(req.params.teamSeasonId),
            personId: input.personId,
            rating: input.rating,
            ...(input.returningNextSeason === undefined
              ? {}
              : { returningNextSeason: input.returningNextSeason }),
            ...(input.notes ? { notes: input.notes } : {}),
            ...(input.expectedVersion === undefined
              ? {}
              : { expectedVersion: input.expectedVersion }),
          }),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.get(
    '/orgs/:orgId/programs/:programId/prior-player-ratings',
    async (req, res) => {
      try {
        res.json(
          await getPriorSeasonPlayerRatings(
            await contextFor(dependencies, req),
            id.parse(req.params.programId),
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.get(
    '/orgs/:orgId/programs/:programId/season-awards',
    async (req, res) => {
      try {
        res.json({
          items: await listSeasonAwards(
            await contextFor(dependencies, req),
            id.parse(req.params.programId),
          ),
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.post(
    '/orgs/:orgId/programs/:programId/season-awards',
    async (req, res) => {
      try {
        mutate(dependencies, req);
        const input = z
          .strictObject({
            personId: id.optional(),
            teamSeasonId: id.optional(),
            title: z.string().trim().min(1).max(200),
            description: z.string().trim().max(4000).optional(),
            certificateFileId: id.optional(),
          })
          .refine(
            (award) => Boolean(award.personId) !== Boolean(award.teamSeasonId),
            'Choose one award recipient type.',
          )
          .parse(req.body);
        res.status(201).json(
          await createSeasonAward(await contextFor(dependencies, req), {
            programId: id.parse(req.params.programId),
            ...(input.personId ? { personId: input.personId } : {}),
            ...(input.teamSeasonId ? { teamSeasonId: input.teamSeasonId } : {}),
            title: input.title,
            ...(input.description ? { description: input.description } : {}),
            ...(input.certificateFileId
              ? { certificateFileId: input.certificateFileId }
              : {}),
          }),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  router.post('/orgs/:orgId/seasons/:seasonId/archive', async (req, res) => {
    try {
      mutate(dependencies, req);
      const input = z
        .strictObject({ expectedVersion: z.number().int().positive() })
        .parse(req.body);
      res.json(
        await archiveSeason(
          await contextFor(dependencies, req),
          id.parse(req.params.seasonId),
          input.expectedVersion,
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/public/orgs/:orgSlug/programs/:programId', async (req, res) => {
    try {
      res.setHeader(
        'Cache-Control',
        'public, max-age=60, stale-while-revalidate=300',
      );
      res.json(
        await getPublicStandingsBySlug(
          z.string().min(1).parse(req.params.orgSlug),
          { programId: id.parse(req.params.programId) },
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get(
    '/public/orgs/:orgSlug/divisions/:divisionId',
    async (req, res) => {
      try {
        res.setHeader(
          'Cache-Control',
          'public, max-age=60, stale-while-revalidate=300',
        );
        res.json(
          await getPublicStandingsBySlug(
            z.string().min(1).parse(req.params.orgSlug),
            { divisionId: id.parse(req.params.divisionId) },
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    },
  );
  return router;
}
