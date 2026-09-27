import {
  householdCreateSchema,
  householdMemberCreateSchema,
  householdMemberRemoveSchema,
  householdMemberUpdateSchema,
  householdUpdateSchema,
  householdsQuerySchema,
} from '@shared/schemas/households';
import {
  guardianInvitationAcceptSchema,
  guardianLinkCreateSchema,
  peopleFilterOptionsQuerySchema,
  peopleQuerySchema,
  personCreateSchema,
  personPhotoUpdateSchema,
  personUpdateSchema,
} from '@shared/schemas/people';
import express from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import { createGuardianLinksRepository } from './guardianLinks';
import { createHouseholdsRepository } from './households';
import { createPeopleRepository, PeopleError } from './repo';

const archiveBodySchema = z.strictObject({
  expectedVersion: z.int().positive(),
});

function validWriteOrigin(request: express.Request, appUrl: string): boolean {
  const bearer =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  return (
    request.get('X-Athlentry-Request') === '1' &&
    (request.get('Origin') === new URL(appUrl).origin ||
      (bearer && request.get('Origin') === undefined))
  );
}

function sendError(response: express.Response, error: unknown): void {
  const status =
    error instanceof z.ZodError
      ? 400
      : error instanceof PeopleError
        ? error.status
        : error instanceof Error &&
            'status' in error &&
            typeof error.status === 'number'
          ? error.status
          : 500;
  response.status(status).json({
    error: {
      code:
        error instanceof z.ZodError
          ? 'VALIDATION_ERROR'
          : error instanceof PeopleError
            ? error.code
            : status === 401
              ? 'UNAUTHENTICATED'
              : 'INTERNAL_ERROR',
      message:
        status === 500
          ? 'The request could not be completed'
          : error instanceof Error
            ? error.message
            : 'Request failed',
    },
  });
}

export function createPeopleRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const people = createPeopleRepository(dependencies.database);
  const households = createHouseholdsRepository(dependencies.database);
  const guardianLinks = createGuardianLinksRepository(dependencies.database);
  router.use(express.json({ limit: '32kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/orgs/:orgId', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const query = peopleQuerySchema.parse(request.query);
      response.json(
        await people.list(
          orgId,
          session.accountId,
          query,
          Boolean(requestImpersonation(request)),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/filter-options', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      response.json(
        await people.filterOptions(
          orgId,
          session.accountId,
          peopleFilterOptionsQuerySchema.parse(request.query),
          Boolean(requestImpersonation(request)),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/:personId', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const personId = z.uuid().parse(request.params.personId);
      response.json(
        await people.get(
          orgId,
          session.accountId,
          personId,
          Boolean(requestImpersonation(request)),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/:personId/guardians', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      response.json(
        await guardianLinks.list(
          z.uuid().parse(request.params.orgId),
          session.accountId,
          z.uuid().parse(request.params.personId),
          Boolean(requestImpersonation(request)),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/:personId/guardians', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
      const { email } = guardianLinkCreateSchema.parse(request.body);
      response
        .status(201)
        .json(
          await guardianLinks.linkExisting(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.personId),
            email.trim().toLowerCase(),
          ),
        );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post(
    '/orgs/:orgId/:personId/guardians/invitations',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const { email } = guardianLinkCreateSchema.parse(request.body);
        response
          .status(201)
          .json(
            await guardianLinks.invite(
              z.uuid().parse(request.params.orgId),
              session.accountId,
              z.uuid().parse(request.params.personId),
              email,
              dependencies.email,
              dependencies.appUrl,
            ),
          );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/guardians/invitations/accept',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const { token } = guardianInvitationAcceptSchema.parse(request.body);
        response.json(
          await guardianLinks.accept(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            token,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/:personId/guardians/:linkId/revoke',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        response.json(
          await guardianLinks.revoke(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.personId),
            z.uuid().parse(request.params.linkId),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post('/orgs/:orgId', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
      const orgId = z.uuid().parse(request.params.orgId);
      response
        .status(201)
        .json(
          await people.create(
            orgId,
            session.accountId,
            personCreateSchema.parse(request.body),
          ),
        );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.patch('/orgs/:orgId/:personId', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
      const orgId = z.uuid().parse(request.params.orgId);
      const personId = z.uuid().parse(request.params.personId);
      response.json(
        await people.update(
          orgId,
          session.accountId,
          personId,
          personUpdateSchema.parse(request.body),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/:personId/photo', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
      const orgId = z.uuid().parse(request.params.orgId);
      const personId = z.uuid().parse(request.params.personId);
      response.json(
        await people.setPhoto(
          orgId,
          session.accountId,
          personId,
          personPhotoUpdateSchema.parse(request.body),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/:personId/archive', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
      const orgId = z.uuid().parse(request.params.orgId);
      const personId = z.uuid().parse(request.params.personId);
      const { expectedVersion } = archiveBodySchema.parse(request.body);
      response.json(
        await people.archive(
          orgId,
          session.accountId,
          personId,
          expectedVersion,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.post('/orgs/:orgId/:personId/restore', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
      const orgId = z.uuid().parse(request.params.orgId);
      const personId = z.uuid().parse(request.params.personId);
      const { expectedVersion } = archiveBodySchema.parse(request.body);
      response.json(
        await people.restore(
          orgId,
          session.accountId,
          personId,
          expectedVersion,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get('/households/orgs/:orgId', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const filters = householdsQuerySchema.parse(request.query);
      response.json(
        await households.list(
          orgId,
          session.accountId,
          filters,
          Boolean(requestImpersonation(request)),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.get(
    '/households/orgs/:orgId/:householdId',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const householdId = z.uuid().parse(request.params.householdId);
        response.json(
          await households.get(
            orgId,
            session.accountId,
            householdId,
            Boolean(requestImpersonation(request)),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post('/households/orgs/:orgId', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
      const orgId = z.uuid().parse(request.params.orgId);
      response
        .status(201)
        .json(
          await households.create(
            orgId,
            session.accountId,
            householdCreateSchema.parse(request.body),
          ),
        );
    } catch (error) {
      sendError(response, error);
    }
  });
  router.patch(
    '/households/orgs/:orgId/:householdId',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const orgId = z.uuid().parse(request.params.orgId);
        const householdId = z.uuid().parse(request.params.householdId);
        response.json(
          await households.update(
            orgId,
            session.accountId,
            householdId,
            householdUpdateSchema.parse(request.body),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/households/orgs/:orgId/:householdId/members',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const orgId = z.uuid().parse(request.params.orgId);
        const householdId = z.uuid().parse(request.params.householdId);
        response
          .status(201)
          .json(
            await households.addMember(
              orgId,
              session.accountId,
              householdId,
              householdMemberCreateSchema.parse(request.body),
            ),
          );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.patch(
    '/households/orgs/:orgId/:householdId/members/:memberId',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const orgId = z.uuid().parse(request.params.orgId);
        const householdId = z.uuid().parse(request.params.householdId);
        const memberId = z.uuid().parse(request.params.memberId);
        response.json(
          await households.updateMember(
            orgId,
            session.accountId,
            householdId,
            memberId,
            householdMemberUpdateSchema.parse(request.body),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  router.post(
    '/households/orgs/:orgId/:householdId/members/:memberId/remove',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const orgId = z.uuid().parse(request.params.orgId);
        const householdId = z.uuid().parse(request.params.householdId);
        const memberId = z.uuid().parse(request.params.memberId);
        const { expectedVersion } = householdMemberRemoveSchema.parse(
          request.body,
        );
        response.json(
          await households.removeMember(
            orgId,
            session.accountId,
            householdId,
            memberId,
            expectedVersion,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  return router;
}
