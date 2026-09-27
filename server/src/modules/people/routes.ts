import {
  emergencyContactCreateSchema,
  emergencyContactRemoveSchema,
  emergencyContactUpdateSchema,
} from '@shared/schemas/emergencyContacts';
import {
  householdCreateSchema,
  householdMemberCreateSchema,
  householdMemberRemoveSchema,
  householdMemberUpdateSchema,
  householdUpdateSchema,
  householdsQuerySchema,
} from '@shared/schemas/households';
import { medicalUpdateSchema } from '@shared/schemas/medical';
import {
  athleteInvitationAcceptSchema,
  athleteInvitationSchema,
  guardianInvitationAcceptSchema,
  guardianLinkCreateSchema,
  peopleFilterOptionsQuerySchema,
  peopleQuerySchema,
  personClaimAcceptSchema,
  personClaimInvitationSchema,
  personCreateSchema,
  personMergeCreateSchema,
  personPhotoUpdateSchema,
  personUpdateSchema,
} from '@shared/schemas/people';
import express from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import { createAthleteLinksRepository } from './athleteLinks';
import { createEmergencyContactsRepository } from './emergencyContacts';
import { listFamily } from './family';
import { createGuardianLinksRepository } from './guardianLinks';
import { createHouseholdsRepository } from './households';
import { createMedicalRepository } from './medical';
import { createMergesRepository } from './merges';
import { createPeopleRepository, PeopleError } from './repo';
import { createSelfClaimsRepository } from './selfClaims';

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
      ...(error instanceof PeopleError && error.details !== undefined
        ? { details: error.details }
        : {}),
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
  const selfClaims = createSelfClaimsRepository(dependencies.database);
  const medical = createMedicalRepository(
    dependencies.database,
    dependencies.encryption,
  );
  const emergencyContacts = createEmergencyContactsRepository(
    dependencies.database,
  );
  const athleteLinks = createAthleteLinksRepository(dependencies.database);
  const merges = createMergesRepository(dependencies.database);
  router.use(express.json({ limit: '32kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/me/family', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(
          403,
          'FORBIDDEN',
          'Impersonation is not supported here',
        );
      response.json(await listFamily(dependencies.database, session.accountId));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/:personId/medical', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(404, 'NOT_FOUND', 'Medical profile not found');
      response.json(
        await medical.read(
          z.uuid().parse(request.params.orgId),
          session.accountId,
          z.uuid().parse(request.params.personId),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get(
    '/orgs/:orgId/:personId/family-profile',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(404, 'NOT_FOUND', 'Person not found');
        response.json(
          await people.getRelated(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.personId),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.patch(
    '/orgs/:orgId/:personId/family-profile',
    async (request, response) => {
      try {
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid request origin');
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        response.json(
          await people.updateRelated(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.personId),
            personUpdateSchema.parse(request.body),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.patch('/orgs/:orgId/:personId/medical', async (request, response) => {
    try {
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid request origin');
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      const orgId = z.uuid().parse(request.params.orgId);
      const personId = z.uuid().parse(request.params.personId);
      await medical.write(
        orgId,
        session.accountId,
        personId,
        medicalUpdateSchema.parse(request.body),
      );
      response.json(await medical.read(orgId, session.accountId, personId));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get(
    '/orgs/:orgId/:personId/emergency-contacts',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(
            404,
            'NOT_FOUND',
            'Emergency contacts not found',
          );
        response.json(
          await emergencyContacts.list(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.personId),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/:personId/emergency-contacts',
    async (request, response) => {
      try {
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid request origin');
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        const orgId = z.uuid().parse(request.params.orgId);
        const personId = z.uuid().parse(request.params.personId);
        await emergencyContacts.create(
          orgId,
          session.accountId,
          personId,
          emergencyContactCreateSchema.parse(request.body),
        );
        response
          .status(201)
          .json(
            await emergencyContacts.list(orgId, session.accountId, personId),
          );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.patch(
    '/orgs/:orgId/:personId/emergency-contacts/:contactId',
    async (request, response) => {
      try {
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid request origin');
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        const orgId = z.uuid().parse(request.params.orgId);
        const personId = z.uuid().parse(request.params.personId);
        await emergencyContacts.update(
          orgId,
          session.accountId,
          personId,
          z.uuid().parse(request.params.contactId),
          emergencyContactUpdateSchema.parse(request.body),
        );
        response.json(
          await emergencyContacts.list(orgId, session.accountId, personId),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/:personId/emergency-contacts/:contactId/remove',
    async (request, response) => {
      try {
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid request origin');
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        const orgId = z.uuid().parse(request.params.orgId);
        const personId = z.uuid().parse(request.params.personId);
        await emergencyContacts.remove(
          orgId,
          session.accountId,
          personId,
          z.uuid().parse(request.params.contactId),
          emergencyContactRemoveSchema.parse(request.body).expectedVersion,
        );
        response.json(
          await emergencyContacts.list(orgId, session.accountId, personId),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

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

  router.get('/orgs/:orgId/duplicates', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(404, 'NOT_FOUND', 'Duplicates not found');
      response.json(
        await merges.duplicates(
          z.uuid().parse(request.params.orgId),
          session.accountId,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/merges', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
      const { survivorId, mergedId } = personMergeCreateSchema.parse(
        request.body,
      );
      response
        .status(201)
        .json(
          await merges.merge(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            survivorId,
            mergedId,
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

  router.get(
    '/orgs/:orgId/:personId/athlete-link',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(404, 'NOT_FOUND', 'Athlete link not found');
        response.json(
          await athleteLinks.get(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.personId),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/:personId/athlete-invitations',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const { email } = athleteInvitationSchema.parse(request.body);
        response
          .status(201)
          .json(
            await athleteLinks.invite(
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
    '/orgs/:orgId/athlete-invitations/accept',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const { token } = athleteInvitationAcceptSchema.parse(request.body);
        response.json(
          await athleteLinks.accept(
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
    '/orgs/:orgId/:personId/athlete-link/revoke',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        response.json(
          await athleteLinks.revoke(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.personId),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/:personId/claim-invitations',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const { email } = personClaimInvitationSchema.parse(request.body);
        response
          .status(201)
          .json(
            await selfClaims.invite(
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
    '/orgs/:orgId/claim-invitations/accept',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const { token } = personClaimAcceptSchema.parse(request.body);
        response.json(
          await selfClaims.accept(
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
