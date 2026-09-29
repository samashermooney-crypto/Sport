import express from 'express';
import pg from 'pg';
import { z } from 'zod';

import { LocalDiskStorage } from '../../integrations/storage/storage';
import { requestImpersonation } from '../../lib/tenant-guard';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';
import { PeopleError } from '../people/repo';

import { importFields } from './phase15-fields';
import {
  phase15ImportKindSchema,
  phase15ImportMappingSchema,
} from './phase15-schema';
import { createImportsService, ImportsError } from './phase15-service';
import { renderTemplate } from './phase15-templates';

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
      : error instanceof PeopleError || error instanceof ImportsError
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
          : error instanceof PeopleError || error instanceof ImportsError
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

export function createPhase15ImportsRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const imports = createImportsService(
    dependencies.database,
    dependencies.encryption,
    new LocalDiskStorage('data/uploads'),
  );
  const processBatchAction =
    (action: 'validate' | 'commit' | 'rollback') =>
    async (request: express.Request, response: express.Response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const orgId = z.uuid().parse(request.params.orgId);
        const batchId = z.uuid().parse(request.params.batchId);
        if (action === 'validate' || action === 'commit') {
          await imports.enqueueProcessing(
            orgId,
            batchId,
            session.accountId,
            action,
          );
          response.status(202).json({ queued: true });
          return;
        }
        response.json(
          await imports.rollbackBatch(orgId, batchId, session.accountId),
        );
      } catch (error) {
        sendError(response, error);
      }
    };

  router.get('/phase15/templates/:kind.csv', (request, response) => {
    try {
      const kind = phase15ImportKindSchema.parse(request.params.kind);
      response
        .type('text/csv; charset=utf-8')
        .setHeader('Content-Disposition', `attachment; filename="${kind}.csv"`)
        .send(renderTemplate(kind));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/phase15/kinds', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      await imports.listBatches(
        orgId,
        session.accountId,
        Boolean(requestImpersonation(request)),
      );
      response.json({
        items: Object.entries(importFields).map(([kind, fields]) => ({
          kind,
          fields: fields.map(({ key, label, required, aliases }) => ({
            key,
            label,
            required,
            aliases,
          })),
        })),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/orgs/:orgId/phase15/batches', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      response.json(
        await imports.listBatches(
          z.uuid().parse(request.params.orgId),
          session.accountId,
          Boolean(requestImpersonation(request)),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post(
    '/orgs/:orgId/phase15/batches',
    express.raw({
      type: [
        'application/octet-stream',
        'text/csv',
        'application/zip',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
      limit: '20mb',
    }),
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        if (!Buffer.isBuffer(request.body))
          throw new ImportsError(
            400,
            'VALIDATION_ERROR',
            'Upload a supported file',
          );
        const kind = phase15ImportKindSchema.parse(request.query['kind']);
        const fileName = z
          .string()
          .trim()
          .min(1)
          .max(255)
          .parse(request.query['name']);
        const batch = await imports.createBatch(
          z.uuid().parse(request.params.orgId),
          session.accountId,
          { kind, fileName, bytes: request.body },
        );
        response.status(201).json(batch);
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/phase15/batches/:batchId/events',
    async (request, response) => {
      let listener: pg.Client | null = null;
      let heartbeat: NodeJS.Timeout | null = null;
      try {
        const session = await requireSession(dependencies, request);
        const orgId = z.uuid().parse(request.params.orgId);
        const batchId = z.uuid().parse(request.params.batchId);
        const impersonating = Boolean(requestImpersonation(request));
        listener = new pg.Client({
          connectionString:
            process.env.DATABASE_URL ??
            'postgres://athlentry_app@127.0.0.1:5432/athlentry_dev',
        });
        await listener.connect();
        await listener.query('LISTEN import_progress');
        response.setHeader('Content-Type', 'text/event-stream');
        response.setHeader('Cache-Control', 'no-cache, no-transform');
        response.setHeader('Connection', 'keep-alive');
        response.flushHeaders();
        const sendProgress = async () => {
          const current = await imports.getBatch(
            orgId,
            session.accountId,
            batchId,
            impersonating,
          );
          if (!response.writableEnded)
            response.write(
              `event: progress\ndata: ${JSON.stringify({ status: current.status, progress: current.progress, rowCount: current.rowCount, errorCount: current.errorCount })}\n\n`,
            );
        };
        listener.on('notification', (notification) => {
          try {
            const payload: unknown = JSON.parse(notification.payload ?? 'null');
            if (
              typeof payload === 'object' &&
              payload !== null &&
              'orgId' in payload &&
              'batchId' in payload &&
              payload.orgId === orgId &&
              payload.batchId === batchId
            )
              void sendProgress().catch(() => response.end());
          } catch {
            /* Ignore unrelated or malformed notifications. */
          }
        });
        await sendProgress();
        heartbeat = setInterval(() => {
          response.write(': keep-alive\n\n');
        }, 15_000);
        response.on('close', () => {
          if (heartbeat) clearInterval(heartbeat);
          void listener?.end();
        });
      } catch (error) {
        if (heartbeat) clearInterval(heartbeat);
        if (listener) await listener.end().catch(() => undefined);
        if (response.headersSent) response.end();
        else sendError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/phase15/batches/:batchId',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        response.json(
          await imports.getBatch(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.batchId),
            Boolean(requestImpersonation(request)),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.get(
    '/orgs/:orgId/phase15/batches/:batchId/rows',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        const query = z
          .strictObject({
            cursor: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
            filter: z.enum(['all', 'errors', 'duplicates']).default('all'),
          })
          .parse(request.query);
        response.json(
          await imports.listRows(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.batchId),
            query,
            Boolean(requestImpersonation(request)),
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/phase15/batches/:batchId/mapping',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const input = z
          .strictObject({
            mapping: phase15ImportMappingSchema,
            savePresetAs: z.string().min(1).max(120).optional(),
          })
          .parse(request.body);
        response.json(
          await imports.setMapping(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.batchId),
            input.mapping,
            input.savePresetAs,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/phase15/batches/:batchId/rows/decisions',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        const input = z
          .strictObject({
            decisions: z
              .array(
                z.strictObject({
                  rowId: z.uuid(),
                  action: z.enum(['create', 'skip']),
                }),
              )
              .min(1)
              .max(200),
          })
          .parse(request.body);
        response.json(
          await imports.decideRows(
            z.uuid().parse(request.params.orgId),
            session.accountId,
            z.uuid().parse(request.params.batchId),
            input.decisions,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/phase15/batches/:batchId/rows/skip-duplicates',
    async (request, response) => {
      try {
        const session = await requireSession(dependencies, request);
        if (requestImpersonation(request))
          throw new PeopleError(403, 'FORBIDDEN', 'Impersonation is read-only');
        if (!validWriteOrigin(request, dependencies.appUrl))
          throw new PeopleError(403, 'FORBIDDEN', 'Invalid write origin');
        response.json(
          await imports.skipAllDuplicates(
            z.uuid().parse(request.params.orgId),
            z.uuid().parse(request.params.batchId),
            session.accountId,
          ),
        );
      } catch (error) {
        sendError(response, error);
      }
    },
  );

  router.post(
    '/orgs/:orgId/phase15/batches/:batchId/validate',
    processBatchAction('validate'),
  );
  router.post(
    '/orgs/:orgId/phase15/batches/:batchId/commit',
    processBatchAction('commit'),
  );
  router.post(
    '/orgs/:orgId/phase15/batches/:batchId/rollback',
    processBatchAction('rollback'),
  );

  router.get('/orgs/:orgId/phase15/presets', async (request, response) => {
    try {
      const session = await requireSession(dependencies, request);
      const kind = request.query['kind']
        ? phase15ImportKindSchema.parse(request.query['kind'])
        : null;
      response.json(
        await imports.listPresets(
          z.uuid().parse(request.params.orgId),
          session.accountId,
          kind,
          Boolean(requestImpersonation(request)),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
