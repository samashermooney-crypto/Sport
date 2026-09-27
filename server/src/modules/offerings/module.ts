import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';
import { installmentTemplateListSchema } from '../finance/installment-templates';

import { createOfferingsRouter } from './routes';
import { offeringInputSchema, offeringUpdateSchema } from './service';
const row = z.looseObject({
  id: z.uuid(),
  org_id: z.uuid(),
  program_id: z.uuid(),
  name: z.string(),
  version: z.number().int().positive(),
});
export const moduleDefinition = {
  name: 'offerings',
  path: '/api/v1/offerings',
  router: createOfferingsRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/offerings/orgs/{orgId}/programs/{programId}',
      summary: 'List program offerings',
      response: z.array(row),
    },
    {
      method: 'post',
      path: '/api/v1/offerings/orgs/{orgId}',
      summary: 'Create registration offering and capacity counter',
      body: offeringInputSchema,
      response: row,
    },
    {
      method: 'patch',
      path: '/api/v1/offerings/orgs/{orgId}/{offeringId}',
      summary: 'Update registration offering',
      body: offeringUpdateSchema,
      response: row,
    },
    {
      method: 'get',
      path: '/api/v1/offerings/orgs/{orgId}/installment-templates',
      summary:
        'List available finance installment plans for the offering editor',
      response: installmentTemplateListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/offerings/orgs/{orgId}/pricing-context',
      summary: 'Read the organization timezone used by offering price windows',
      response: z.strictObject({ timezone: z.string() }),
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
