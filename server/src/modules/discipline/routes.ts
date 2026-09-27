import express from 'express';
import { z } from 'zod';

import type { AuthDependencies } from '../auth/routes';
import {
  isComplianceOfficer,
  mutationOriginIsValid,
  orgActor,
  requireAnyRole,
  sendModuleError,
} from '../compliance/access';

import {
  createDisciplineRecord,
  listDisciplineRecords,
  updateDisciplineRecord,
} from './service';

const uuid = (value: unknown) => z.uuid().parse(value);

export function createDisciplineRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
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
  const manager = async (request: express.Request) => {
    const actor = await orgActor(dependencies, request);
    requireAnyRole(actor.roles, ['owner', 'admin', 'compliance']);
    return actor;
  };

  router.post(
    '/organizations/:orgId/records',
    endpoint(async (request, response) => {
      const actor = await manager(request);
      const body = z
        .strictObject({
          personId: z.uuid().nullable().optional(),
          teamSeasonId: z.uuid().nullable().optional(),
          contestId: z.uuid().nullable().optional(),
          type: z.enum([
            'caution',
            'send_off',
            'ejection',
            'technical',
            'suspension',
            'fine',
            'other',
          ]),
          description: z.string().trim().min(3).max(4000),
          suspensionGames: z
            .number()
            .int()
            .min(0)
            .max(100)
            .nullable()
            .optional(),
          suspensionUntil: z.iso.date().nullable().optional(),
        })
        .parse(request.body);
      response.status(201).json(
        await createDisciplineRecord(dependencies.database, actor.context, {
          type: body.type,
          description: body.description,
          personId: body.personId ?? null,
          teamSeasonId: body.teamSeasonId ?? null,
          contestId: body.contestId ?? null,
          suspensionGames: body.suspensionGames ?? null,
          suspensionUntil: body.suspensionUntil ?? null,
        }),
      );
    }),
  );
  router.get(
    '/organizations/:orgId/people/:personId',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      response.json(
        await listDisciplineRecords(
          dependencies.database,
          actor.context,
          uuid(request.params.personId),
        ),
      );
    }),
  );
  router.get(
    '/organizations/:orgId',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      if (!isComplianceOfficer(actor.roles)) {
        response.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'A team assignment is required',
          },
        });
        return;
      }
      response.json(
        await listDisciplineRecords(dependencies.database, actor.context),
      );
    }),
  );
  router.patch(
    '/organizations/:orgId/records/:recordId',
    endpoint(async (request, response) => {
      const actor = await manager(request);
      const body = z
        .discriminatedUnion('action', [
          z.strictObject({
            action: z.literal('serve_games'),
            games: z.number().int().min(1).max(100),
            version: z.number().int().positive(),
          }),
          z.strictObject({
            action: z.literal('appeal'),
            version: z.number().int().positive(),
          }),
          z.strictObject({
            action: z.literal('overturn'),
            version: z.number().int().positive(),
          }),
        ])
        .parse(request.body);
      response.json(
        await updateDisciplineRecord(dependencies.database, actor.context, {
          recordId: uuid(request.params.recordId),
          ...body,
        }),
      );
    }),
  );
  return router;
}
