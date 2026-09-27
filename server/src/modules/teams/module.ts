import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createTeamsRouter } from './routes';
import {
  staffInputSchema,
  teamForProgramInputSchema,
  teamGeneratorSchema,
  teamInputSchema,
  teamSeasonInputSchema,
} from './service';
const row = z.looseObject({
  id: z.uuid(),
  org_id: z.uuid(),
  version: z.number().int().positive(),
});
export const moduleDefinition = {
  name: 'teams',
  path: '/api/v1/teams',
  router: createTeamsRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/teams/orgs/{orgId}',
      summary: 'List team seasons',
      response: z.array(row),
    },
    {
      method: 'post',
      path: '/api/v1/teams/orgs/{orgId}',
      summary: 'Create a persistent team',
      body: teamInputSchema,
      response: row,
    },
    {
      method: 'post',
      path: '/api/v1/teams/orgs/{orgId}/seasons/manual',
      summary: 'Create a persistent team and team-season in one transaction',
      body: teamForProgramInputSchema,
      response: z.object({ team: row, season: row }),
    },
    {
      method: 'post',
      path: '/api/v1/teams/orgs/{orgId}/seasons',
      summary: 'Add a team to a program season',
      body: teamSeasonInputSchema,
      response: row,
    },
    {
      method: 'post',
      path: '/api/v1/teams/orgs/{orgId}/generate',
      summary: 'Generate teams in a division',
      body: teamGeneratorSchema,
      response: z.array(z.object({ team: row, season: row })),
    },
    {
      method: 'post',
      path: '/api/v1/teams/orgs/{orgId}/seasons/{teamSeasonId}/staff',
      summary: 'Assign compliance-gated team staff',
      body: staffInputSchema,
      response: row,
    },
    {
      method: 'post',
      path: '/api/v1/teams/orgs/{orgId}/seasons/{teamSeasonId}/roster-lock',
      summary: 'Lock or unlock roster',
      body: z.object({
        expectedVersion: z.number().int().positive(),
        locked: z.boolean(),
      }),
      response: row,
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
