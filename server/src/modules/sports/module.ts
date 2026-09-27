import { sportProfileSchema } from '@shared/sport/schema';
import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createSportsRouter } from './routes';

const profileResponseSchema = z.object({
  id: z.uuid(),
  template_key: z.string().nullable(),
  name: z.string(),
  profile: sportProfileSchema,
  version: z.number().int().positive(),
  hasResults: z.boolean().optional(),
});
export const moduleDefinition = {
  name: 'sports',
  path: '/api/v1/sports',
  router: createSportsRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/sports/templates',
      summary: 'Browse built-in sport templates',
      response: z.array(
        z.object({
          key: z.string(),
          name: z.object({ en: z.string(), es: z.string().optional() }),
          category: z.string(),
          profile: sportProfileSchema,
        }),
      ),
    },
    {
      method: 'get',
      path: '/api/v1/sports/orgs/{orgId}',
      summary: 'List organization sport profiles',
      response: z.array(profileResponseSchema),
    },
    {
      method: 'post',
      path: '/api/v1/sports/orgs/{orgId}',
      summary: 'Clone a sport template',
      body: z.object({ templateKey: z.string() }),
      response: profileResponseSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/sports/orgs/{orgId}/{profileId}',
      summary: 'Version an organization sport profile',
      body: z.object({
        expectedVersion: z.number().int().positive(),
        profile: sportProfileSchema,
      }),
      response: profileResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/sports/orgs/{orgId}/{profileId}/versions',
      summary: 'List sport profile versions',
      response: z.array(
        z.object({
          version: z.number(),
          profile: sportProfileSchema,
          created_at: z.iso.datetime(),
        }),
      ),
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
