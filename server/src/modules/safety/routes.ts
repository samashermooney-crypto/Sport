import express from 'express';
import { z } from 'zod';

import type { AuthDependencies } from '../auth/routes';
import {
  AccessError,
  isComplianceOfficer,
  isOwner,
  mutationOriginIsValid,
  orgActor,
  requireAnyRole,
  sendModuleError,
} from '../compliance/access';

import {
  listClearanceReviews,
  listIncidents,
  listInjuries,
  readIncident,
  reportIncident,
  reportInjury,
  reviewClearance,
  submitClearance,
  updateIncident,
} from './service';
import type { SafetyDependencies } from './service';

const id = (value: unknown) => z.uuid().parse(value);

export function createSafetyRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const safety: SafetyDependencies = {
    database: dependencies.database,
    encryption: dependencies.encryption,
    clock: dependencies.clock,
  };
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  router.use((request, response, next) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !mutationOriginIsValid(request, dependencies.appUrl)
    ) {
      response.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Request origin could not be verified',
        },
      });
      return;
    }
    next();
  });
  router.use(express.json({ limit: '32kb' }));
  const endpoint =
    (
      action: (
        request: express.Request,
        response: express.Response,
      ) => Promise<void>,
    ) =>
    async (request: express.Request, response: express.Response) => {
      try {
        await action(request, response);
      } catch (error) {
        sendModuleError(response, error);
      }
    };
  const officer = async (request: express.Request) => {
    const actor = await orgActor(dependencies, request);
    requireAnyRole(actor.roles, ['owner', 'admin', 'compliance']);
    return actor;
  };
  const safetyOfficer = async (request: express.Request) => {
    const actor = await orgActor(dependencies, request);
    requireAnyRole(actor.roles, ['owner', 'compliance']);
    return actor;
  };

  router.post(
    '/organizations/:orgId/injuries',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const body = z
        .strictObject({
          personId: z.uuid(),
          eventId: z.uuid().nullable().optional(),
          occurredAt: z.iso.datetime(),
          bodyPart: z.string().trim().max(100).nullable().optional(),
          injuryType: z.string().trim().max(100).nullable().optional(),
          suspectedConcussion: z.boolean(),
          description: z.string().trim().min(4).max(20_000),
        })
        .parse(request.body);
      response.status(201).json(
        await reportInjury(safety, actor.context, {
          personId: body.personId,
          occurredAt: body.occurredAt,
          suspectedConcussion: body.suspectedConcussion,
          description: body.description,
          eventId: body.eventId ?? null,
          bodyPart: body.bodyPart ?? null,
          injuryType: body.injuryType ?? null,
        }),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/people/:personId/injuries',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(
        await listInjuries(safety, actor.context, id(request.params.personId)),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/injuries/:injuryId/clearances',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const body = z
        .strictObject({
          fileId: z.uuid(),
          providerName: z.string().trim().min(2).max(200),
          clearedOn: z.iso.date(),
        })
        .parse(request.body);
      response.status(201).json(
        await submitClearance(safety, actor.context, {
          injuryReportId: id(request.params.injuryId),
          ...body,
        }),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/clearances/review-queue',
    endpoint(async (request, response) => {
      const actor = await safetyOfficer(request);
      response.json(
        await listClearanceReviews(dependencies.database, actor.context),
      );
    }),
  );
  router.post(
    '/organizations/:orgId/clearances/:clearanceId/review',
    endpoint(async (request, response) => {
      const actor = await safetyOfficer(request);
      const body = z
        .strictObject({
          decision: z.enum(['approve', 'reject']),
          reason: z.string().trim().max(2000).optional(),
          version: z.number().int().positive(),
        })
        .parse(request.body);
      const { reason, ...review } = body;
      response.json(
        await reviewClearance(dependencies.database, actor.context, {
          clearanceId: id(request.params.clearanceId),
          ...review,
          ...(reason !== undefined ? { reason } : {}),
        }),
      );
    }),
  );

  router.post(
    '/organizations/:orgId/incidents',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const body = z
        .strictObject({
          category: z.enum([
            'safety',
            'behavior',
            'safesport_concern',
            'facility',
            'other',
          ]),
          occurredAt: z.iso.datetime(),
          eventId: z.uuid().nullable().optional(),
          peopleInvolved: z.array(z.uuid()).max(100),
          narrative: z.string().trim().min(10).max(20_000),
        })
        .parse(request.body);
      response.status(201).json(
        await reportIncident(safety, actor.context, {
          category: body.category,
          occurredAt: body.occurredAt,
          peopleInvolved: body.peopleInvolved,
          narrative: body.narrative,
          eventId: body.eventId ?? null,
        }),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/incidents',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      const canReview = isComplianceOfficer(actor.roles);
      response.json(
        await listIncidents(dependencies.database, actor.context, {
          canReview,
          canReadRestricted:
            isOwner(actor.roles) || actor.roles.includes('compliance'),
        }),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/incidents/:incidentId',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(
        await readIncident(
          safety,
          actor.context,
          id(request.params.incidentId),
          {
            canReview: isComplianceOfficer(actor.roles),
            canReadRestricted:
              isOwner(actor.roles) || actor.roles.includes('compliance'),
          },
        ),
      );
    }),
  );
  router.patch(
    '/organizations/:orgId/incidents/:incidentId',
    endpoint(async (request, response) => {
      const actor = await officer(request);
      const body = z
        .strictObject({
          status: z.enum(['open', 'under_review', 'closed']),
          resolution: z.string().trim().max(20_000).nullable().optional(),
          version: z.number().int().positive(),
        })
        .parse(request.body);
      const existing = await readIncident(
        safety,
        actor.context,
        id(request.params.incidentId),
        {
          canReview: true,
          canReadRestricted:
            isOwner(actor.roles) || actor.roles.includes('compliance'),
        },
      );
      if (
        existing.restricted &&
        !(isOwner(actor.roles) || actor.roles.includes('compliance'))
      )
        throw new AccessError(404, 'NOT_FOUND', 'Incident not found');
      response.json(
        await updateIncident(safety, actor.context, {
          incidentId: id(request.params.incidentId),
          status: body.status,
          version: body.version,
          resolution: body.resolution ?? null,
        }),
      );
    }),
  );

  return router;
}
