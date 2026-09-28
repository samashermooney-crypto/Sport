import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { divisionGeneratorSchema } from './division-generator';
import { createProgramsRouter } from './routes';
import {
  programInputSchema,
  programListQuerySchema,
  programUpdateSchema,
  programStatusSchema,
  divisionInputSchema,
} from './service';

const row = z.looseObject({
  id: z.uuid(),
  org_id: z.uuid(),
  version: z.number().int().positive(),
});
export const moduleDefinition = {
  name: 'programs',
  path: '/api/v1/programs',
  router: createProgramsRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/programs/orgs/{orgId}',
      summary: 'List programs',
      query: {
        seasonId: programListQuerySchema.shape.seasonId,
        mode: programListQuerySchema.shape.mode,
        status: programListQuerySchema.shape.status,
      },
      response: z.array(row),
    },
    {
      method: 'post',
      path: '/api/v1/programs/orgs/{orgId}',
      summary: 'Create program with default division',
      body: programInputSchema,
      response: row,
    },
    {
      method: 'get',
      path: '/api/v1/programs/orgs/{orgId}/{programId}',
      summary: 'Read program, divisions and offerings',
      response: z.object({
        program: row,
        divisions: z.array(row),
        offerings: z.array(row),
      }),
    },
    {
      method: 'patch',
      path: '/api/v1/programs/orgs/{orgId}/{programId}',
      summary: 'Update program settings',
      body: programUpdateSchema,
      response: row,
    },
    {
      method: 'post',
      path: '/api/v1/programs/orgs/{orgId}/{programId}/status',
      summary: 'Change program lifecycle state',
      body: z.object({
        status: programStatusSchema,
        expectedVersion: z.number().int().positive(),
      }),
      response: row,
    },
    {
      method: 'post',
      path: '/api/v1/programs/orgs/{orgId}/{programId}/divisions',
      summary: 'Create division',
      body: divisionInputSchema,
      response: row,
    },
    {
      method: 'post',
      path: '/api/v1/programs/orgs/{orgId}/{programId}/divisions/generate',
      summary: 'Generate age or grade divisions',
      body: divisionGeneratorSchema,
      response: z.array(row),
    },
    {
      method: 'get',
      path: '/api/v1/programs/catalog/{orgSlug}',
      summary: 'Public program catalog data',
      response: z.looseObject({
        organization: z.object({ slug: z.string(), name: z.string() }),
        programs: z.array(z.unknown()),
      }),
    },
    {
      method: 'get',
      path: '/api/v1/programs/catalog/{orgSlug}/{programSlug}',
      summary: 'Public program detail data',
      response: z.looseObject({
        organization: z.object({ slug: z.string(), name: z.string() }),
        programs: z.array(z.unknown()),
      }),
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
