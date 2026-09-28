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
import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createExportsRouter } from './routes';
import { runOrganizationExportJob, runRetentionSweepJob } from './service';

export const moduleDefinition = {
  name: 'exports',
  path: '/api/v1/exports',
  router: createExportsRouter,
  jobs: [
    {
      name: 'exports.build-org',
      run: runOrganizationExportJob,
    },
    {
      name: 'retention.sweep',
      cron: '0 3 * * 0',
      run: runRetentionSweepJob,
    },
  ],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/exports/orgs/{orgId}/privacy-requests',
      summary: 'List organization privacy requests',
      response: privacyRequestListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/exports/orgs/{orgId}/privacy-requests',
      summary: 'Create a step-up protected privacy request',
      body: createPrivacyRequestSchema,
      response: privacyRequestSchema,
      status: 201,
    },
    {
      method: 'patch',
      path: '/api/v1/exports/orgs/{orgId}/privacy-requests/{requestId}',
      summary: 'Advance a privacy request workflow',
      body: updatePrivacyRequestSchema,
      response: privacyRequestSchema,
    },
    {
      method: 'post',
      path: '/api/v1/exports/orgs/{orgId}/privacy-requests/{requestId}/access-export',
      summary: 'Create a step-up protected access export for a subject',
      response: privacySubjectExportSchema,
    },
    {
      method: 'get',
      path: '/api/v1/exports/orgs/{orgId}/retention-policy',
      summary: 'Get organization retention policy',
      response: retentionPolicySchema,
    },
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
