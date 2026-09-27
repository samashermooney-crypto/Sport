import {
  createBatchQuerySchema,
  importBatchListSchema,
  importBatchSchema,
  importDecisionsBodySchema,
  importKindSchema,
  importKindsResponseSchema,
  importQueuedResponseSchema,
  importRowListSchema,
  mappingPresetListSchema,
  rollbackBatchResponseSchema,
  setMappingBodySchema,
  suggestMappingResponseSchema,
} from '@shared/schemas/imports';
import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import { LocalDiskStorage } from '../../integrations/storage/storage';
import type { ServerModule } from '../../lib/module-contract';
import { requireSession } from '../auth/routes';
import type { AuthDependencies } from '../auth/routes';

import { importsJobs } from './jobs';
import { createImportsRouter } from './routes';
import { ImportsError, createImportsService } from './service';

const openapiRoutes = [
  {
    method: 'get',
    path: '/api/v1/imports/kinds',
    summary: 'List available import kinds and fields',
    response: importKindsResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/imports/templates/{kind}.csv',
    summary: 'Download a sample CSV template',
    response: z.string(),
    contentType: 'text/csv',
  },
  {
    method: 'get',
    path: '/api/v1/imports/batches',
    summary: 'List import batches',
    response: importBatchListSchema,
  },
  {
    method: 'post',
    path: '/api/v1/imports/batches',
    summary: 'Upload an import file and create a batch',
    response: importBatchSchema,
    status: 201,
    requestContentType: 'application/octet-stream',
    requestBinary: true,
    query: {
      kind: createBatchQuerySchema.shape.kind,
      name: createBatchQuerySchema.shape.name,
    },
  },
  {
    method: 'get',
    path: '/api/v1/imports/batches/{id}',
    summary: 'Read an import batch',
    response: importBatchSchema,
  },
  {
    method: 'get',
    path: '/api/v1/imports/batches/{id}/suggest-mapping',
    summary: 'Suggest an import column mapping',
    response: suggestMappingResponseSchema,
  },
  {
    method: 'put',
    path: '/api/v1/imports/batches/{id}/mapping',
    summary: 'Set an import mapping',
    body: setMappingBodySchema,
    response: importBatchSchema,
  },
  {
    method: 'get',
    path: '/api/v1/imports/batches/{id}/rows',
    summary: 'List import rows',
    response: importRowListSchema,
    query: {
      cursor: z.string().optional(),
      limit: z.string().optional(),
      filter: z.enum(['all', 'errors', 'duplicates']).optional(),
    },
  },
  {
    method: 'post',
    path: '/api/v1/imports/batches/{id}/decisions',
    summary: 'Set row decisions for a validated import',
    body: importDecisionsBodySchema,
    response: z.null(),
    status: 204,
  },
  {
    method: 'post',
    path: '/api/v1/imports/batches/{id}/validate',
    summary: 'Queue import validation',
    response: importQueuedResponseSchema,
    status: 202,
  },
  {
    method: 'post',
    path: '/api/v1/imports/batches/{id}/commit',
    summary: 'Queue import commit',
    response: importQueuedResponseSchema,
    status: 202,
  },
  {
    method: 'post',
    path: '/api/v1/imports/batches/{id}/rollback',
    summary: 'Roll back a committed import batch',
    response: rollbackBatchResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/imports/batches/{id}/progress',
    summary: 'Stream import progress events',
    response: z.string(),
    contentType: 'text/event-stream',
  },
  {
    method: 'get',
    path: '/api/v1/imports/presets',
    summary: 'List available import mapping presets',
    response: mappingPresetListSchema,
    query: { kind: importKindSchema.optional() },
  },
];

function createMountedImportsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const scoped = createWithOrg(dependencies.database);
  const service = createImportsService(
    dependencies.database,
    dependencies.encryption,
    new LocalDiskStorage('data/uploads'),
  );
  router.use((request, response, next) => {
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
      request.method,
    );
    const bearer =
      /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
      !request.headers.cookie;
    if (
      mutating &&
      (request.get('X-Athlentry-Request') !== '1' ||
        (request.get('Origin') !== new URL(dependencies.appUrl).origin &&
          !(bearer && !request.get('Origin'))))
    ) {
      response.status(403).json({
        error: 'FORBIDDEN',
        message: 'Request origin could not be verified',
      });
      return;
    }
    next();
  });
  router.use(
    createImportsRouter({
      service,
      connectionString:
        process.env.DATABASE_URL ??
        'postgres://athlentry_app@127.0.0.1:5432/athlentry_dev',
      context: async (request) => {
        let accountId: string;
        try {
          accountId = (await requireSession(dependencies, request)).accountId;
        } catch {
          throw new ImportsError(401, 'UNAUTHORIZED', 'Sign in required');
        }
        const parsed = z.uuid().safeParse(request.get('X-Athlentry-Org'));
        if (!parsed.success)
          throw new ImportsError(404, 'NOT_FOUND', 'Organization not found');
        const context = { orgId: parsed.data, actor: { accountId } };
        const member = await scoped(context, (trx) =>
          trx
            .selectFrom('org_memberships')
            .select('id')
            .where('org_id', '=', context.orgId)
            .where('account_id', '=', accountId)
            .where('status', '=', 'active')
            .executeTakeFirst(),
        );
        if (!member)
          throw new ImportsError(404, 'NOT_FOUND', 'Organization not found');
        return context;
      },
    }),
  );
  return router;
}

export const moduleDefinition = {
  name: 'imports',
  path: '/api/v1/imports',
  router: createMountedImportsRouter,
  jobs: importsJobs,
  permissions: [],
  errorCodes: [],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
