import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createFacilitiesRouter } from './routes';
import {
  availabilityInputSchema,
  availabilityUpdateSchema,
  blackoutInputSchema,
  facilityInputSchema,
  spaceInputSchema,
} from './service';
const row = z.looseObject({ id: z.uuid(), org_id: z.uuid() });
export const moduleDefinition = {
  name: 'facilities',
  path: '/api/v1/facilities',
  router: createFacilitiesRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/facilities/orgs/{orgId}',
      summary: 'List facilities and spaces',
      response: z.object({ facilities: z.array(row), spaces: z.array(row) }),
    },
    {
      method: 'post',
      path: '/api/v1/facilities/orgs/{orgId}',
      summary: 'Create facility',
      body: facilityInputSchema,
      response: row,
    },
    {
      method: 'patch',
      path: '/api/v1/facilities/orgs/{orgId}/{facilityId}',
      summary: 'Update facility',
      body: z.object({
        expectedVersion: z.number().int().positive(),
        facility: facilityInputSchema,
      }),
      response: row,
    },
    {
      method: 'post',
      path: '/api/v1/facilities/orgs/{orgId}/spaces',
      summary: 'Create space or split-field child',
      body: spaceInputSchema,
      response: row,
    },
    {
      method: 'get',
      path: '/api/v1/facilities/orgs/{orgId}/spaces/{spaceId}/availability',
      summary: 'List space availability windows',
      response: z.array(row),
    },
    {
      method: 'post',
      path: '/api/v1/facilities/orgs/{orgId}/availability',
      summary: 'Create structured recurrence availability',
      body: availabilityInputSchema,
      response: row,
    },
    {
      method: 'patch',
      path: '/api/v1/facilities/orgs/{orgId}/availability/{availabilityId}',
      summary: 'Update structured recurrence availability',
      body: availabilityUpdateSchema,
      response: row,
    },
    {
      method: 'get',
      path: '/api/v1/facilities/orgs/{orgId}/blackouts',
      summary: 'List upcoming space and facility blackouts',
      response: z.array(row),
    },
    {
      method: 'post',
      path: '/api/v1/facilities/orgs/{orgId}/blackouts',
      summary: 'Create a blackout window',
      body: blackoutInputSchema,
      response: row,
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
