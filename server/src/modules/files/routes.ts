import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgContext } from '../../db/withOrg';

import {
  FilePermissionError,
  FileValidationError,
  FilesService,
} from './service';

export const uploadBody = z.strictObject({
  purpose: z.enum(['image', 'document', 'import', 'website_asset']),
  mime: z.string().min(1).max(200),
  bytes: z.number().int().positive(),
  ownerType: z.string().max(80).optional(),
  ownerId: z.uuid().optional(),
  sensitivity: z
    .enum(['public', 'internal', 'sensitive', 'restricted'])
    .optional(),
});
export interface FilesRoutesDependencies {
  files: FilesService;
  context(request: Request): Promise<OrgContext>;
}

export function createFilesRouter(dependencies: FilesRoutesDependencies) {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  router.post('/uploads', async (request, response, next) => {
    try {
      const body = uploadBody.parse(request.body);
      const result = await dependencies.files.beginUpload({
        context: await dependencies.context(request),
        purpose: body.purpose,
        mime: body.mime,
        bytes: body.bytes,
        ...(body.ownerType ? { ownerType: body.ownerType } : {}),
        ...(body.ownerId ? { ownerId: body.ownerId } : {}),
        ...(body.sensitivity ? { sensitivity: body.sensitivity } : {}),
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });
  router.post('/uploads/:id/complete', async (request, response, next) => {
    try {
      const result = await dependencies.files.completeUpload(
        await dependencies.context(request),
        z.uuid().parse(request.params.id),
      );
      response.json(result);
    } catch (error) {
      next(error);
    }
  });
  router.put(
    '/uploads/:id/content',
    express.raw({ type: () => true, limit: '20mb' }),
    async (request, response, next) => {
      try {
        if (!Buffer.isBuffer(request.body))
          throw new FileValidationError('Upload body is missing');
        await dependencies.files.uploadLocalBytes(
          await dependencies.context(request),
          z.uuid().parse(request.params.id),
          request.body,
        );
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/:id/download', async (request, response, next) => {
    try {
      const url = await dependencies.files.download(
        await dependencies.context(request),
        z.uuid().parse(request.params.id),
      );
      response.json({ url, expiresInSeconds: 300 });
    } catch (error) {
      next(error);
    }
  });
  router.get('/:id/content', async (request, response, next) => {
    try {
      const content = await dependencies.files.readLocalContent(
        await dependencies.context(request),
        z.uuid().parse(request.params.id),
      );
      response
        .type(content.mime)
        .set('Content-Disposition', 'attachment')
        .send(Buffer.from(content.bytes));
    } catch (error) {
      next(error);
    }
  });
  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: express.NextFunction,
    ) => {
      if (error instanceof FilePermissionError) {
        response
          .status(403)
          .json({ error: 'FORBIDDEN', message: error.message });
        return;
      }
      if (error instanceof FileValidationError) {
        response
          .status(error.message === 'File not found' ? 404 : 400)
          .json({ error: 'FILE_INVALID', message: error.message });
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
