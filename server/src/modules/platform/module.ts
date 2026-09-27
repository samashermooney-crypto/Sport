import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { featureFlagInputSchema, planInputSchema } from './admin';
import { createPlatformRouter } from './routes';
import {
  featureFlagResultSchema,
  featureFlagsSchema,
  healthSchema,
  impersonationInputSchema,
  impersonationSchema,
  okSchema,
  orgDetailSchema,
  orgPageSchema,
  platformMeSchema,
  planAssignmentResultSchema,
  planAssignmentSchema,
  plansSchema,
  saveResultSchema,
  staffInputSchema,
  staffListSchema,
  staffResultSchema,
  statusInputSchema,
  statusResultSchema,
} from './schema';

export const moduleDefinition = {
  name: 'platform',
  path: '/api/v1/platform',
  router: createPlatformRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/platform/me',
      summary: 'Get platform staff role',
      response: platformMeSchema,
    },
    {
      method: 'get',
      path: '/api/v1/platform/orgs',
      summary: 'List organizations',
      response: orgPageSchema,
      query: {
        limit: z.string().optional(),
        cursor: z.string().optional(),
        search: z.string().optional(),
      },
    },
    {
      method: 'get',
      path: '/api/v1/platform/orgs/{orgId}',
      summary: 'Get organization',
      response: orgDetailSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/platform/orgs/{orgId}/status',
      summary: 'Suspend or reactivate organization',
      body: statusInputSchema,
      response: statusResultSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/platform/orgs/{orgId}/plan',
      summary: 'Assign organization plan',
      body: planAssignmentSchema,
      response: planAssignmentResultSchema,
    },
    {
      method: 'get',
      path: '/api/v1/platform/plans',
      summary: 'List platform plans',
      response: plansSchema,
    },
    {
      method: 'post',
      path: '/api/v1/platform/plans',
      summary: 'Create platform plan',
      body: planInputSchema,
      response: saveResultSchema,
      status: 201,
    },
    {
      method: 'put',
      path: '/api/v1/platform/plans/{id}',
      summary: 'Update platform plan',
      body: planInputSchema,
      response: saveResultSchema,
    },
    {
      method: 'get',
      path: '/api/v1/platform/feature-flags',
      summary: 'List feature flags',
      response: featureFlagsSchema,
    },
    {
      method: 'put',
      path: '/api/v1/platform/feature-flags/{key}',
      summary: 'Save feature flag',
      body: featureFlagInputSchema,
      response: featureFlagResultSchema,
    },
    {
      method: 'get',
      path: '/api/v1/platform/staff',
      summary: 'List platform staff',
      response: staffListSchema,
    },
    {
      method: 'put',
      path: '/api/v1/platform/staff/{accountId}',
      summary: 'Save platform staff',
      body: staffInputSchema,
      response: staffResultSchema,
    },
    {
      method: 'post',
      path: '/api/v1/platform/impersonations',
      summary: 'Begin audited read-only impersonation',
      body: impersonationInputSchema,
      response: impersonationSchema,
      status: 201,
    },
    {
      method: 'get',
      path: '/api/v1/platform/impersonations/{id}',
      summary: 'Get impersonation status',
      response: impersonationSchema,
    },
    {
      method: 'delete',
      path: '/api/v1/platform/impersonations/{id}',
      summary: 'End impersonation',
      response: okSchema,
    },
    {
      method: 'get',
      path: '/api/v1/platform/health',
      summary: 'Get platform system health',
      response: healthSchema,
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
