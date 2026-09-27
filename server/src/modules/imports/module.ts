import {
  importBatchListSchema,
  importBatchPreviewSchema,
  importBatchSchema,
  importMappingPresetListSchema,
  importMappingPresetSchema,
  importBatchCreateSchema,
  importMappingPresetSaveSchema,
} from '@shared/schemas/imports';
import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createImportsRouter } from './routes';

export const moduleDefinition = {
  name: 'imports',
  path: '/api/v1/imports',
  router: createImportsRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/imports/orgs/{orgId}/batches',
      summary: 'List import batches',
      response: importBatchListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/imports/orgs/{orgId}/batches',
      summary: 'Create an import batch and preview staged rows',
      body: importBatchCreateSchema,
      response: importBatchPreviewSchema,
    },
    {
      method: 'get',
      path: '/api/v1/imports/orgs/{orgId}/batches/{batchId}',
      summary: 'Read an import batch with per-row preview',
      response: importBatchPreviewSchema,
    },
    {
      method: 'post',
      path: '/api/v1/imports/orgs/{orgId}/batches/{batchId}/commit',
      summary: 'Commit a previewed import batch',
      response: importBatchSchema,
    },
    {
      method: 'post',
      path: '/api/v1/imports/orgs/{orgId}/batches/{batchId}/rollback',
      summary: 'Roll back a committed import batch',
      response: importBatchSchema,
    },
    {
      method: 'get',
      path: '/api/v1/imports/orgs/{orgId}/presets',
      summary: 'List saved column-mapping presets',
      query: {
        kind: z
          .enum(['people', 'households', 'guardians', 'emergency_contacts'])
          .optional(),
      },
      response: importMappingPresetListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/imports/orgs/{orgId}/presets',
      summary: 'Save a column-mapping preset',
      body: importMappingPresetSaveSchema,
      response: importMappingPresetSchema,
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
