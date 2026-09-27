import {
  waiverDocumentCreateSchema,
  waiverDocumentUpdateSchema,
  waiverSignatureCreateSchema,
} from '@shared/schemas/waivers';
import express from 'express';
import { z } from 'zod';

import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import { createWaiversService, WaiversError } from './service';

const publishSchema = z.strictObject({ expectedVersion: z.int().positive() });
const signaturesQuerySchema = z.strictObject({
  participantPersonId: z.uuid(),
});
const personQuerySchema = z.strictObject({ personId: z.uuid() });

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
      : error instanceof WaiversError
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
          : error instanceof WaiversError
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

export function createWaiversRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const waivers = createWaiversService(dependencies.database);
  router.use(express.json({ limit: '64kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/orgs/:orgId', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new WaiversError(404, 'NOT_FOUND', 'Waiver was not found');
      response.json(
        await waivers.list({
          orgId: z.uuid().parse(request.params.orgId),
          actor: { accountId: session.accountId },
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/person', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new WaiversError(404, 'NOT_FOUND', 'Waiver was not found');
      const query = personQuerySchema.parse(request.query);
      response.json(
        await waivers.listForPerson(
          {
            orgId: z.uuid().parse(request.params.orgId),
            actor: { accountId: session.accountId },
          },
          query.personId,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId', async (request, response) => {
    try {
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new WaiversError(403, 'FORBIDDEN', 'Invalid request origin');
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new WaiversError(403, 'FORBIDDEN', 'Impersonation is read-only');
      response.status(201).json(
        await waivers.create(
          {
            orgId: z.uuid().parse(request.params.orgId),
            actor: { accountId: session.accountId },
          },
          waiverDocumentCreateSchema.parse(request.body),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.patch('/orgs/:orgId/:waiverId', async (request, response) => {
    try {
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new WaiversError(403, 'FORBIDDEN', 'Invalid request origin');
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new WaiversError(403, 'FORBIDDEN', 'Impersonation is read-only');
      response.json(
        await waivers.update(
          {
            orgId: z.uuid().parse(request.params.orgId),
            actor: { accountId: session.accountId },
          },
          z.uuid().parse(request.params.waiverId),
          waiverDocumentUpdateSchema.parse(request.body),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/orgs/:orgId/:waiverId/publish', async (request, response) => {
    try {
      if (!validWriteOrigin(request, dependencies.appUrl))
        throw new WaiversError(403, 'FORBIDDEN', 'Invalid request origin');
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new WaiversError(403, 'FORBIDDEN', 'Impersonation is read-only');
      const input = publishSchema.parse(request.body);
      response.json(
        await waivers.publish(
          {
            orgId: z.uuid().parse(request.params.orgId),
            actor: { accountId: session.accountId },
          },
          z.uuid().parse(request.params.waiverId),
          input.expectedVersion,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post(
    '/orgs/:orgId/:waiverId/signatures',
    async (request, response) => {
      try {
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new WaiversError(403, 'FORBIDDEN', 'Invalid request origin');
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new WaiversError(
            403,
            'FORBIDDEN',
            'Impersonation is read-only',
          );
        response.status(201).json(
          await waivers.sign(
            {
              orgId: z.uuid().parse(request.params.orgId),
              actor: { accountId: session.accountId },
            },
            z.uuid().parse(request.params.waiverId),
            waiverSignatureCreateSchema.parse(request.body),
            {
              ip: request.ip ?? null,
              userAgent: request.get('user-agent') ?? null,
            },
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get('/orgs/:orgId/signatures', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      if (requestImpersonation(request))
        throw new WaiversError(404, 'NOT_FOUND', 'Waiver was not found');
      const query = signaturesQuerySchema.parse(request.query);
      response.json(
        await waivers.listSignatures(
          {
            orgId: z.uuid().parse(request.params.orgId),
            actor: { accountId: session.accountId },
          },
          query.participantPersonId,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get(
    '/orgs/:orgId/signatures/:signatureId/pdf',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new WaiversError(
            404,
            'NOT_FOUND',
            'Signed waiver was not found',
          );
        const pdf = await waivers.signedPdf(
          {
            orgId: z.uuid().parse(request.params.orgId),
            actor: { accountId: session.accountId },
          },
          z.uuid().parse(request.params.signatureId),
        );
        response
          .setHeader('Cache-Control', 'private, no-store')
          .setHeader(
            'Content-Disposition',
            'attachment; filename="signed-waiver.pdf"',
          )
          .type('application/pdf')
          .send(Buffer.from(pdf));
      } catch (error) {
        sendError(response, error);
      }
    },
  );
  return router;
}
