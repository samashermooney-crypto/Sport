import express from 'express';
import { z } from 'zod';

import type { AuthDependencies } from '../auth/routes';
import {
  mutationOriginIsValid,
  orgActor,
  requireAnyRole,
  sendModuleError,
} from '../compliance/access';

import {
  publicSponsorListSchema,
  sponsorBodySchema,
  sponsorInvoiceBodySchema,
  sponsorListSchema,
  sponsorPatchSchema,
  sponsorSchema,
  sponsorStatusBodySchema,
} from './schema';
import {
  createSponsor,
  getSponsor,
  issueSponsorInvoice,
  listSponsors,
  publicSponsorPlacements,
  setSponsorStatus,
  updateSponsor,
} from './service';

const managers = ['owner', 'admin', 'finance'] as const;
const uuid = (value: unknown) => z.uuid().parse(value);
const surfaces = z.enum([
  'website_home',
  'program_page',
  'team_page',
  'email_footer',
]);

export function createSponsorsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
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
  router.use(express.json({ limit: '48kb' }));
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

  router.get(
    '/public/orgs/:orgSlug/sponsors',
    endpoint(async (request, response) => {
      const surface = surfaces.parse(request.query.surface ?? 'website_home');
      const target = request.query.targetId
        ? uuid(request.query.targetId)
        : undefined;
      const sponsors = await publicSponsorPlacements(
        dependencies.database,
        String(request.params.orgSlug),
        surface,
        target,
        dependencies.clock(),
      );
      response.json(publicSponsorListSchema.parse({ sponsors }));
    }),
  );
  router.get(
    '/orgs/:orgId/sponsors',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      response.json(
        sponsorListSchema.parse({
          sponsors: await listSponsors(dependencies.database, actor.context),
        }),
      );
    }),
  );
  router.post(
    '/orgs/:orgId/sponsors',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const body = sponsorBodySchema.parse(request.body as unknown);
      const id = await createSponsor(
        dependencies.database,
        actor.context,
        body,
      );
      response
        .status(201)
        .json(
          sponsorSchema.parse(
            await getSponsor(dependencies.database, actor.context, id),
          ),
        );
    }),
  );
  router.get(
    '/orgs/:orgId/sponsors/:sponsorId',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      response.json(
        sponsorSchema.parse(
          await getSponsor(
            dependencies.database,
            actor.context,
            uuid(request.params.sponsorId),
          ),
        ),
      );
    }),
  );
  router.patch(
    '/orgs/:orgId/sponsors/:sponsorId',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const sponsor = await updateSponsor(
        dependencies.database,
        actor.context,
        uuid(request.params.sponsorId),
        sponsorPatchSchema.parse(request.body as unknown),
      );
      response.json(sponsorSchema.parse(sponsor));
    }),
  );
  router.patch(
    '/orgs/:orgId/sponsors/:sponsorId/status',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const sponsor = await setSponsorStatus(
        dependencies.database,
        actor.context,
        uuid(request.params.sponsorId),
        sponsorStatusBodySchema.parse(request.body as unknown),
      );
      response.json(sponsorSchema.parse(sponsor));
    }),
  );
  router.post(
    '/orgs/:orgId/sponsors/:sponsorId/invoice',
    endpoint(async (request, response) => {
      const actor = await orgActor(dependencies, request);
      requireAnyRole(actor.roles, managers);
      const body = sponsorInvoiceBodySchema.parse(request.body as unknown);
      const result = await issueSponsorInvoice(
        dependencies.database,
        actor.context,
        uuid(request.params.sponsorId),
        {
          ...body,
          creationKey: uuid(request.get('Idempotency-Key')),
        },
      );
      response.status(201).json(result);
    }),
  );
  return router;
}
