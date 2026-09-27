import { apiErrorSchema } from '@shared/schemas/errors';
import {
  fileDownloadLinkSchema,
  fileRecordResponseSchema,
  fileUploadRequestSchema,
  fileUploadResultSchema,
} from '@shared/schemas/files';
import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgContext } from '../../db/withOrg';

import {
  FilePermissionError,
  FileValidationError,
  FilesService,
} from './service';

const uploadBody = fileUploadRequestSchema;
export interface FilesRoutesDependencies {
  files: FilesService;
  context(request: Request): Promise<OrgContext>;
  publicFacilityLayout(
    orgSlug: string,
    facilityId: string,
  ): Promise<{ bytes: Uint8Array; mime: 'image/webp' | 'image/jpeg' } | null>;
}

export function createFilesRouter(dependencies: FilesRoutesDependencies) {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  router.get(
    '/public/orgs/:orgSlug/facilities/:facilityId/layout',
    async (request, response, next) => {
      const orgSlug = z
        .string()
        .trim()
        .min(1)
        .max(100)
        .safeParse(request.params.orgSlug);
      const facilityId = z.uuid().safeParse(request.params.facilityId);
      if (!orgSlug.success || !facilityId.success) {
        response.status(404).end();
        return;
      }
      try {
        const content = await dependencies.publicFacilityLayout(
          orgSlug.data,
          facilityId.data,
        );
        if (!content) {
          response.status(404).end();
          return;
        }
        response
          .type(content.mime)
          .set({
            'Cache-Control': 'no-store',
            'Content-Disposition': 'inline',
            'X-Content-Type-Options': 'nosniff',
          })
          .send(Buffer.from(content.bytes));
      } catch (error) {
        next(error);
      }
    },
  );
  router.post('/uploads', async (request, response, next) => {
    try {
      const body = uploadBody.parse(request.body);
      const result = fileUploadResultSchema.parse(
        await dependencies.files.beginUpload({
          context: await dependencies.context(request),
          purpose: body.purpose,
          mime: body.mime,
          bytes: body.bytes,
          ...(body.ownerType ? { ownerType: body.ownerType } : {}),
          ...(body.ownerId ? { ownerId: body.ownerId } : {}),
          ...(body.sensitivity ? { sensitivity: body.sensitivity } : {}),
        }),
      );
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });
  router.post('/uploads/:id/complete', async (request, response, next) => {
    try {
      const completed = await dependencies.files.completeUpload(
        await dependencies.context(request),
        z.uuid().parse(request.params.id),
      );
      const result = fileRecordResponseSchema.parse({
        id: completed.id,
        orgId: completed.orgId,
        purpose: completed.purpose,
        ownerType: completed.ownerType,
        ownerId: completed.ownerId,
        mime: completed.mime,
        bytes: completed.bytes,
        sha256: completed.sha256,
        width: completed.width,
        height: completed.height,
        sensitivity: completed.sensitivity,
        uploadState: completed.uploadState,
      });
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
      const link = fileDownloadLinkSchema.parse({
        url: await dependencies.files.download(
          await dependencies.context(request),
          z.uuid().parse(request.params.id),
        ),
        expiresInSeconds: 300,
      });
      response.json(link);
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
        response.status(403).json(
          apiErrorSchema.parse({
            error: { code: 'FORBIDDEN', message: error.message },
          }),
        );
        return;
      }
      if (error instanceof FileValidationError) {
        const notFound = error.message === 'File not found';
        response.status(notFound ? 404 : 400).json(
          apiErrorSchema.parse({
            error: {
              code: notFound ? 'NOT_FOUND' : 'FILE_INVALID',
              message: error.message,
            },
          }),
        );
        return;
      }
      if (error instanceof z.ZodError) {
        const fields = Object.fromEntries(
          error.issues.flatMap((issue) =>
            issue.path.length ? [[issue.path.join('.'), issue.message]] : [],
          ),
        );
        response.status(400).json(
          apiErrorSchema.parse({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
              ...(Object.keys(fields).length ? { fields } : {}),
            },
          }),
        );
        return;
      }
      next(error);
    },
  );
  return router;
}
