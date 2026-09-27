import {
  organizationExportDownloadLinkSchema,
  organizationExportListSchema,
  organizationExportRequestResponseSchema,
} from '@shared/schemas/exports';
import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createExportsRouter } from './routes';
import { runOrganizationExportJob } from './service';

export const moduleDefinition = {
  name: 'exports',
  path: '/api/v1/exports',
  router: createExportsRouter,
  jobs: [
    {
      name: 'exports.build-org',
      run: runOrganizationExportJob,
    },
  ],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/exports/orgs/{orgId}/exports',
      summary: 'List organization data exports',
      response: organizationExportListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/exports/orgs/{orgId}/exports',
      summary: 'Request a step-up protected organization data export',
      response: organizationExportRequestResponseSchema,
      status: 202,
    },
    {
      method: 'post',
      path: '/api/v1/exports/orgs/{orgId}/exports/{exportId}/download-link',
      summary: 'Issue a seven-day organization export download link',
      response: organizationExportDownloadLinkSchema,
    },
    {
      method: 'get',
      path: '/api/v1/exports/download/{token}',
      summary: 'Download an organization export using a signed link',
      response: z.string(),
      contentType: 'application/octet-stream',
      binary: true,
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
