import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createRostersRouter } from './routes';
import { rosterInputSchema, rosterUpdateSchema } from './service';
const row = z.looseObject({
  id: z.uuid(),
  org_id: z.uuid(),
  version: z.number().int().positive(),
});
export const moduleDefinition = {
  name: 'rosters',
  path: '/api/v1/rosters',
  router: createRostersRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/rosters/orgs/{orgId}/team-seasons/{teamSeasonId}',
      summary: 'List roster entries',
      response: z.array(row),
    },
    {
      method: 'post',
      path: '/api/v1/rosters/orgs/{orgId}/team-seasons/{teamSeasonId}',
      summary: 'Add an athlete or guest to a roster',
      body: rosterInputSchema,
      response: row,
    },
    {
      method: 'patch',
      path: '/api/v1/rosters/orgs/{orgId}/{entryId}',
      summary: 'Change jersey number or positions',
      body: rosterUpdateSchema,
      response: row,
    },
    {
      method: 'post',
      path: '/api/v1/rosters/orgs/{orgId}/{entryId}/move',
      summary: 'Move athlete to a team in the program',
      body: z.object({
        destinationTeamSeasonId: z.uuid(),
        expectedVersion: z.number().int().positive(),
      }),
      response: row,
    },
    {
      method: 'post',
      path: '/api/v1/rosters/orgs/{orgId}/{entryId}/release',
      summary: 'Release roster entry',
      body: z.object({ expectedVersion: z.number().int().positive() }),
      response: row,
    },
    {
      method: 'get',
      path: '/api/v1/rosters/orgs/{orgId}/team-seasons/{teamSeasonId}/export.csv',
      summary: 'Export roster CSV',
      response: z.string(),
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
