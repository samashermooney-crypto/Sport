import { z } from 'zod';

import { getDatabase } from '../../db/kysely';
import type { ServerModule } from '../../lib/module-contract';

import { createSponsorsRouter } from './routes';
import {
  publicSponsorListSchema,
  sponsorBodySchema,
  sponsorInvoiceBodySchema,
  sponsorListSchema,
  sponsorPatchSchema,
  sponsorSchema,
  sponsorStatusBodySchema,
} from './schema';
import { runSponsorRenewalJob } from './service';

async function renewalReminders() {
  return runSponsorRenewalJob(getDatabase());
}

const base = '/api/v1/sponsors/orgs/{orgId}/sponsors';
const route = (
  method: 'get' | 'post' | 'patch',
  path: string,
  summary: string,
  response: z.ZodType,
  body?: z.ZodType,
) => ({
  method,
  path,
  summary,
  response,
  tags: ['sponsors'],
  ...(body ? { body } : {}),
});
const openapiRoutes = [
  route(
    'get',
    '/api/v1/sponsors/public/orgs/{orgSlug}/sponsors',
    'List active sponsors for a public placement surface',
    publicSponsorListSchema,
  ),
  route(
    'get',
    base,
    'List sponsors with contract and invoice state',
    sponsorListSchema,
  ),
  route(
    'post',
    base,
    'Create a sponsor record',
    sponsorSchema,
    sponsorBodySchema,
  ),
  route('get', `${base}/{sponsorId}`, 'Read a sponsor record', sponsorSchema),
  route(
    'patch',
    `${base}/{sponsorId}`,
    'Update sponsor details',
    sponsorSchema,
    sponsorPatchSchema,
  ),
  route(
    'patch',
    `${base}/{sponsorId}/status`,
    'Transition a sponsor between prospect, active, expired, archived',
    sponsorSchema,
    sponsorStatusBodySchema,
  ),
  route(
    'post',
    `${base}/{sponsorId}/invoice`,
    'Issue a sponsorship invoice through finance',
    z.json(),
    sponsorInvoiceBodySchema,
  ),
];

export const moduleDefinition = {
  name: 'sponsors',
  path: '/api/v1/sponsors',
  router: createSponsorsRouter,
  jobs: [
    {
      name: 'sponsors.renewal-reminders',
      cron: '15 7 * * *',
      run: renewalReminders,
    },
  ],
  permissions: ['sponsors.read', 'sponsors.manage'],
  notificationTypes: ['sponsor.renewal_reminder'],
  errorCodes: [],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
