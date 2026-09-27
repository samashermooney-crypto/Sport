import { importKindSchema, importMappingSchema } from '@shared/schemas/imports';
import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgContext } from '../../db/withOrg';
import { listenSse } from '../../lib/sse';

import { importFields } from './fields';
import { ImportsError } from './service';
import type { ImportsService } from './service';
import { renderTemplate } from './templates';

const decideBody = z.strictObject({
  decisions: z
    .array(
      z.strictObject({
        rowId: z.uuid(),
        action: z.enum(['create', 'update', 'merge', 'skip']),
        targetId: z.uuid().optional(),
      }),
    )
    .min(1)
    .max(2000),
});

const mappingBody = z.strictObject({
  mapping: importMappingSchema,
  savePresetAs: z.string().min(1).max(120).optional(),
});

const rowsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  filter: z.enum(['all', 'errors', 'duplicates']).default('all'),
});

export interface ImportsRoutesDependencies {
  service: ImportsService;
  connectionString: string;
  context(
    request: Request,
  ): Promise<OrgContext & { actor: { accountId: string } }>;
}

export function createImportsRouter(dependencies: ImportsRoutesDependencies) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  const wrap =
    (
      handler: (
        request: Request,
        response: Response,
        context: OrgContext & { actor: { accountId: string } },
      ) => unknown,
    ) =>
    async (
      request: Request,
      response: Response,
      next: express.NextFunction,
    ) => {
      try {
        await Promise.resolve(
          handler(request, response, await dependencies.context(request)),
        );
      } catch (error) {
        next(error);
      }
    };

  router.get('/kinds', (_request, response) => {
    response.json({
      items: Object.entries(importFields).map(([kind, fields]) => ({
        kind,
        fields: fields.map((field) => ({
          key: field.key,
          label: field.label,
          required: field.required,
          aliases: field.aliases,
        })),
      })),
    });
  });

  router.get(
    '/templates/:kind.csv',
    wrap((request, response) => {
      const kind = importKindSchema.parse(request.params.kind);
      response
        .type('text/csv')
        .set(
          'Content-Disposition',
          `attachment; filename="athlentry-${kind}-template.csv"`,
        )
        .send(renderTemplate(kind));
    }),
  );

  router.get(
    '/batches',
    wrap(async (_request, response, context) => {
      response.json(
        await dependencies.service.listBatches(
          context.orgId,
          context.actor.accountId,
        ),
      );
    }),
  );

  router.post(
    '/batches',
    express.raw({ type: () => true, limit: '20mb' }),
    wrap(async (request, response, context) => {
      const kind = importKindSchema.parse(request.query.kind);
      const fileName =
        typeof request.query.name === 'string' && request.query.name.length > 0
          ? request.query.name.slice(0, 200)
          : 'import.csv';
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0)
        throw new ImportsError(
          400,
          'VALIDATION_ERROR',
          'Upload body is missing',
        );
      const batch = await dependencies.service.createBatch(
        context.orgId,
        context.actor.accountId,
        {
          kind,
          fileName,
          bytes: new Uint8Array(request.body),
        },
      );
      response.status(201).json(batch);
    }),
  );

  router.get(
    '/batches/:id',
    wrap(async (request, response, context) => {
      response.json(
        await dependencies.service.getBatch(
          context.orgId,
          context.actor.accountId,
          z.uuid().parse(request.params.id),
        ),
      );
    }),
  );

  router.get(
    '/batches/:id/suggest-mapping',
    wrap(async (request, response, context) => {
      response.json(
        await dependencies.service.suggestMapping(
          context.orgId,
          context.actor.accountId,
          z.uuid().parse(request.params.id),
        ),
      );
    }),
  );

  router.put(
    '/batches/:id/mapping',
    wrap(async (request, response, context) => {
      const body = mappingBody.parse(request.body);
      response.json(
        await dependencies.service.setMapping(
          context.orgId,
          context.actor.accountId,
          z.uuid().parse(request.params.id),
          body.mapping,
          body.savePresetAs,
        ),
      );
    }),
  );

  router.get(
    '/batches/:id/rows',
    wrap(async (request, response, context) => {
      const query = rowsQuery.parse(request.query);
      response.json(
        await dependencies.service.listRows(
          context.orgId,
          context.actor.accountId,
          z.uuid().parse(request.params.id),
          query,
        ),
      );
    }),
  );

  router.post(
    '/batches/:id/decisions',
    wrap(async (request, response, context) => {
      const body = decideBody.parse(request.body);
      await dependencies.service.decideRows(
        context.orgId,
        context.actor.accountId,
        z.uuid().parse(request.params.id),
        body.decisions,
      );
      response.status(204).end();
    }),
  );

  router.post(
    '/batches/:id/validate',
    wrap(async (request, response, context) => {
      const batchId = z.uuid().parse(request.params.id);
      await dependencies.service.progress(
        context.orgId,
        context.actor.accountId,
        batchId,
      );
      await dependencies.service.enqueueProcessing(
        context.orgId,
        batchId,
        context.actor.accountId,
        'validate',
      );
      response.status(202).json({ queued: true });
    }),
  );

  router.post(
    '/batches/:id/commit',
    wrap(async (request, response, context) => {
      const batchId = z.uuid().parse(request.params.id);
      await dependencies.service.progress(
        context.orgId,
        context.actor.accountId,
        batchId,
      );
      await dependencies.service.enqueueProcessing(
        context.orgId,
        batchId,
        context.actor.accountId,
        'commit',
      );
      response.status(202).json({ queued: true });
    }),
  );

  router.post(
    '/batches/:id/rollback',
    wrap(async (request, response, context) => {
      response.json(
        await dependencies.service.rollbackBatch(
          context.orgId,
          z.uuid().parse(request.params.id),
          context.actor.accountId,
        ),
      );
    }),
  );

  router.get(
    '/batches/:id/progress',
    wrap(async (request, response, context) => {
      const batchId = z.uuid().parse(request.params.id);
      const initial = await dependencies.service.progress(
        context.orgId,
        context.actor.accountId,
        batchId,
      );
      await listenSse(response, {
        connectionString: dependencies.connectionString,
        channel: 'import_progress',
        accept: (payload) => {
          try {
            const parsed = JSON.parse(payload) as {
              orgId?: string;
              batchId?: string;
            };
            if (parsed.batchId !== batchId || parsed.orgId !== context.orgId)
              return null;
            return { event: 'import.progress', data: parsed };
          } catch {
            return null;
          }
        },
      });
      response.write(
        `event: import.progress\ndata: ${JSON.stringify({ batchId, ...initial })}\n\n`,
      );
    }),
  );

  router.get(
    '/presets',
    wrap(async (request, response, context) => {
      const kind = request.query.kind
        ? importKindSchema.parse(request.query.kind)
        : null;
      response.json(
        await dependencies.service.listPresets(
          context.orgId,
          context.actor.accountId,
          kind,
        ),
      );
    }),
  );

  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: express.NextFunction,
    ) => {
      if (error instanceof ImportsError) {
        response
          .status(error.status)
          .json({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        response
          .status(400)
          .json({ error: 'VALIDATION_ERROR', issues: error.issues });
        return;
      }
      next(error);
    },
  );
  return router;
}
