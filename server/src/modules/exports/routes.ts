import { apiErrorSchema } from '@shared/schemas/errors';
import {
  organizationExportDownloadLinkSchema,
  organizationExportListSchema,
  organizationExportRequestResponseSchema,
  createPrivacyRequestSchema,
  privacyRequestListSchema,
  privacyRequestSchema,
  privacySubjectExportSchema,
  retentionPolicySchema,
  updatePrivacyRequestSchema,
} from '@shared/schemas/exports';
import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { LocalDiskStorage } from '../../integrations/storage/storage';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';
import { hasStepUp } from '../auth/sessions';

import {
  createOrganizationExportDownloadLink,
  createOrganizationPrivacyRequest,
  createPrivacySubjectExport,
  downloadOrganizationExport,
  getOrganizationRetentionPolicy,
  listOrganizationPrivacyRequests,
  listOrganizationExports,
  OrganizationExportError,
  requestOrganizationExport,
  updateOrganizationPrivacyRequest,
} from './service';

const emptyBodySchema = z.strictObject({});
const exportIdSchema = z.uuid();
const downloadTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

function requestContext(orgId: string, accountId: string): OrgContext {
  return { orgId, actor: { accountId } };
}

function mutationOriginIsValid(
  request: express.Request,
  appUrl: string,
): boolean {
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
      : error instanceof OrganizationExportError
        ? error.status
        : 500;
  const code =
    error instanceof OrganizationExportError
      ? error.code
      : status === 400
        ? 'VALIDATION_ERROR'
        : status === 401
          ? 'UNAUTHENTICATED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 404
              ? 'NOT_FOUND'
              : status === 409
                ? 'CONFLICT'
                : 'INTERNAL_ERROR';
  response.status(status).json(
    apiErrorSchema.parse({
      error: {
        code,
        message:
          status >= 500
            ? 'The request could not be completed'
            : error instanceof Error
              ? error.message
              : 'Request failed',
      },
    }),
  );
}

function route(
  handler: (
    request: express.Request,
    response: express.Response,
  ) => Promise<void>,
) {
  return (request: express.Request, response: express.Response) => {
    void handler(request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  };
}

async function sessionContext(
  dependencies: AuthDependencies,
  request: express.Request,
) {
  const session = await requireSession(dependencies, request);
  const orgId = z.uuid().parse(request.params.orgId);
  return {
    session,
    context: requestContext(orgId, session.accountId),
  };
}

function requireMutationOrigin(
  request: express.Request,
  response: express.Response,
  dependencies: AuthDependencies,
): boolean {
  if (mutationOriginIsValid(request, dependencies.appUrl)) return true;
  sendError(
    response,
    new OrganizationExportError(
      403,
      'FORBIDDEN',
      'Request origin is not allowed',
    ),
  );
  return false;
}

export function createExportsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const withOrg = createWithOrg(dependencies.database);
  const storage = new LocalDiskStorage('data/uploads');

  router.use(express.json({ limit: '64kb' }));

  router.get(
    '/orgs/:orgId/exports',
    route(async (request, response) => {
      const { context } = await sessionContext(dependencies, request);
      const result = await listOrganizationExports(context, withOrg);
      response.setHeader('Cache-Control', 'no-store');
      response.json(organizationExportListSchema.parse(result));
    }),
  );

  router.get(
    '/orgs/:orgId/privacy-requests',
    route(async (request, response) => {
      const { context } = await sessionContext(dependencies, request);
      const result = await listOrganizationPrivacyRequests(context, withOrg);
      response.setHeader('Cache-Control', 'no-store');
      response.json(privacyRequestListSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/privacy-requests',
    route(async (request, response) => {
      if (!requireMutationOrigin(request, response, dependencies)) return;
      const { session, context } = await sessionContext(dependencies, request);
      const input = createPrivacyRequestSchema.parse(request.body);
      const result = await createOrganizationPrivacyRequest(
        context,
        input,
        hasStepUp(session, dependencies.clock()),
        withOrg,
      );
      response
        .status(201)
        .setHeader('Cache-Control', 'no-store')
        .json(privacyRequestSchema.parse(result));
    }),
  );

  router.patch(
    '/orgs/:orgId/privacy-requests/:requestId',
    route(async (request, response) => {
      if (!requireMutationOrigin(request, response, dependencies)) return;
      const { session, context } = await sessionContext(dependencies, request);
      const input = updatePrivacyRequestSchema.parse(request.body);
      const result = await updateOrganizationPrivacyRequest(
        context,
        z.uuid().parse(request.params.requestId),
        input,
        hasStepUp(session, dependencies.clock()),
        dependencies.clock(),
        withOrg,
      );
      response
        .setHeader('Cache-Control', 'no-store')
        .json(privacyRequestSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/privacy-requests/:requestId/access-export',
    route(async (request, response) => {
      if (!requireMutationOrigin(request, response, dependencies)) return;
      const { session, context } = await sessionContext(dependencies, request);
      emptyBodySchema.parse(request.body ?? {});
      const result = await createPrivacySubjectExport(
        context,
        z.uuid().parse(request.params.requestId),
        hasStepUp(session, dependencies.clock()),
        dependencies.clock(),
        withOrg,
        dependencies.encryption,
      );
      response
        .setHeader('Cache-Control', 'no-store')
        .json(privacySubjectExportSchema.parse(result));
    }),
  );

  router.get(
    '/orgs/:orgId/retention-policy',
    route(async (request, response) => {
      const { context } = await sessionContext(dependencies, request);
      const result = await getOrganizationRetentionPolicy(context, withOrg);
      response.setHeader('Cache-Control', 'no-store');
      response.json(retentionPolicySchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/exports',
    route(async (request, response) => {
      if (!requireMutationOrigin(request, response, dependencies)) return;
      const { session, context } = await sessionContext(dependencies, request);
      emptyBodySchema.parse(request.body ?? {});
      const result = await requestOrganizationExport(
        context,
        hasStepUp(session, dependencies.clock()),
        undefined,
        withOrg,
      );
      response
        .status(202)
        .json(organizationExportRequestResponseSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/exports/:exportId/download-link',
    route(async (request, response) => {
      if (!requireMutationOrigin(request, response, dependencies)) return;
      const { session, context } = await sessionContext(dependencies, request);
      emptyBodySchema.parse(request.body ?? {});
      const result = await createOrganizationExportDownloadLink(
        context,
        exportIdSchema.parse(request.params.exportId),
        hasStepUp(session, dependencies.clock()),
        dependencies.appUrl,
        dependencies.clock(),
        withOrg,
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(organizationExportDownloadLinkSchema.parse(result));
    }),
  );

  router.get(
    '/download/:token',
    route(async (request, response) => {
      const token = downloadTokenSchema.parse(request.params.token);
      const bytes = await downloadOrganizationExport(
        token,
        dependencies.database,
        storage,
        dependencies.clock(),
      );
      response
        .setHeader('Cache-Control', 'no-store')
        .setHeader('Content-Type', 'application/zip')
        .setHeader(
          'Content-Disposition',
          'attachment; filename="athlentry-organization-export.zip"',
        )
        .send(Buffer.from(bytes));
    }),
  );

  return router;
}
