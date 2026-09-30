import { z } from 'zod';

import {
  phase15ImportKindSchema,
  phase15ImportMappingSchema,
} from './phase15-schema';

const looseObject = z.object({}).catchall(z.unknown());
const kindQuerySchema = phase15ImportKindSchema;

export const phase15ImportOpenApiRoutes = [
  {
    method: 'get',
    path: '/api/v1/imports/phase15/templates/{kind}.csv',
    summary: 'Download a generic CSV import template',
    response: z.string(),
    contentType: 'text/csv',
    public: true,
  },
  {
    method: 'get',
    path: '/api/v1/imports/orgs/{orgId}/phase15/kinds',
    summary: 'List import kinds and supported fields',
    response: z.object({ items: z.array(looseObject) }),
  },
  {
    method: 'get',
    path: '/api/v1/imports/orgs/{orgId}/phase15/batches',
    summary: 'List extended import batches',
    response: z.object({ items: z.array(looseObject) }),
  },
  {
    method: 'post',
    path: '/api/v1/imports/orgs/{orgId}/phase15/batches',
    summary: 'Upload and preview an extended import batch',
    query: { kind: kindQuerySchema, name: z.string().min(1).max(255) },
    requestContentTypes: [
      'application/octet-stream',
      'text/csv',
      'application/zip',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    response: looseObject,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/imports/orgs/{orgId}/phase15/batches/{batchId}/events',
    summary: 'Stream import validation progress',
    response: z.string(),
    contentType: 'text/event-stream',
  },
  {
    method: 'get',
    path: '/api/v1/imports/orgs/{orgId}/phase15/batches/{batchId}',
    summary: 'Read an extended import batch preview',
    response: looseObject,
  },
  {
    method: 'get',
    path: '/api/v1/imports/orgs/{orgId}/phase15/batches/{batchId}/rows',
    summary: 'Read paginated normalized import rows',
    query: {
      cursor: z.string().optional(),
      limit: z.string().optional(),
      filter: z.enum(['all', 'errors', 'duplicates']).optional(),
    },
    response: z.object({
      items: z.array(looseObject),
      nextCursor: z.string().nullable(),
    }),
  },
  {
    method: 'post',
    path: '/api/v1/imports/orgs/{orgId}/phase15/batches/{batchId}/mapping',
    summary: 'Save a batch column mapping and optional preset',
    body: z.object({
      mapping: phase15ImportMappingSchema,
      savePresetAs: z.string().min(1).max(120).optional(),
    }),
    response: looseObject,
  },
  {
    method: 'post',
    path: '/api/v1/imports/orgs/{orgId}/phase15/batches/{batchId}/rows/decisions',
    summary: 'Resolve duplicate and row-level import decisions',
    body: z.object({
      decisions: z
        .array(
          z.object({ rowId: z.uuid(), action: z.enum(['create', 'skip']) }),
        )
        .min(1)
        .max(200),
    }),
    response: z.object({ updated: z.number().int().nonnegative() }),
  },
  {
    method: 'post',
    path: '/api/v1/imports/orgs/{orgId}/phase15/batches/{batchId}/rows/skip-duplicates',
    summary: 'Skip every detected duplicate in a batch',
    response: z.object({ skipped: z.number().int().nonnegative() }),
  },
  {
    method: 'post',
    path: '/api/v1/imports/orgs/{orgId}/phase15/batches/{batchId}/validate',
    summary: 'Queue import row validation',
    response: z.object({ queued: z.literal(true) }),
    status: 202,
  },
  {
    method: 'post',
    path: '/api/v1/imports/orgs/{orgId}/phase15/batches/{batchId}/commit',
    summary: 'Queue a validated import commit',
    response: z.object({ queued: z.literal(true) }),
    status: 202,
  },
  {
    method: 'post',
    path: '/api/v1/imports/orgs/{orgId}/phase15/batches/{batchId}/rollback',
    summary: 'Reversibly roll back an imported batch',
    response: looseObject,
  },
  {
    method: 'get',
    path: '/api/v1/imports/orgs/{orgId}/phase15/presets',
    summary: 'List extended column-mapping presets',
    query: { kind: phase15ImportKindSchema.optional() },
    response: z.object({ items: z.array(looseObject) }),
  },
] as const;
