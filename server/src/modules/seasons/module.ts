import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createSeasonsRouter } from './routes';
import {
  rolloverSchema,
  seasonCreateSchema,
  seasonUpdateSchema,
} from './service';

const row = z.looseObject({
  id: z.uuid(),
  org_id: z.uuid(),
  name: z.string(),
  status: z.string(),
  version: z.number().int().positive(),
});
const previewProgram = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
  copiedStartsOn: z.string(),
  copiedEndsOn: z.string(),
  divisions: z.array(
    z.strictObject({
      program_id: z.uuid(),
      name: z.string(),
      age_label: z.string().nullable(),
      competition_gender: z.string().nullable(),
    }),
  ),
  offerings: z.array(
    z.strictObject({
      name: z.string(),
      priceCents: z.number().int().nonnegative(),
      formCount: z.number().int().nonnegative(),
      waiverCount: z.number().int().nonnegative(),
      addOnCount: z.number().int().nonnegative(),
    }),
  ),
});
export const moduleDefinition = {
  name: 'seasons',
  path: '/api/v1/seasons',
  router: createSeasonsRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/seasons/orgs/{orgId}',
      summary: 'List seasons',
      response: z.array(row),
    },
    {
      method: 'post',
      path: '/api/v1/seasons/orgs/{orgId}',
      summary: 'Create season',
      body: seasonCreateSchema,
      response: row,
    },
    {
      method: 'patch',
      path: '/api/v1/seasons/orgs/{orgId}/{seasonId}',
      summary: 'Update season lifecycle',
      body: seasonUpdateSchema,
      response: row,
    },
    {
      method: 'post',
      path: '/api/v1/seasons/orgs/{orgId}/{seasonId}/rollover/preview',
      summary: 'Preview season copy with team and staff selection',
      body: rolloverSchema,
      response: z.looseObject({
        source: z.object({
          id: z.uuid(),
          name: z.string(),
          startsOn: z.string(),
          endsOn: z.string(),
        }),
        target: z.object({
          name: z.string(),
          startsOn: z.string(),
          endsOn: z.string(),
        }),
        programs: z.array(previewProgram),
        teams: z.array(z.unknown()),
        staff: z.array(z.unknown()),
        exclusions: z.array(z.string()),
      }),
    },
    {
      method: 'post',
      path: '/api/v1/seasons/orgs/{orgId}/{seasonId}/rollover',
      summary: 'Copy a season once with Idempotency-Key',
      idempotencyKey: true,
      status: 201,
      body: rolloverSchema,
      response: z.object({
        season: row,
        copied: z.object({
          programs: z.number(),
          teams: z.number(),
          staff: z.number(),
        }),
      }),
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
