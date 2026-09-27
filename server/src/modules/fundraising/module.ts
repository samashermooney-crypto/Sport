import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createFundraisingRouter } from './routes';
import {
  campaignBodySchema,
  campaignListSchema,
  campaignSchema,
  campaignStateSchema,
  donorStatementSchema,
  fundraisingSettingsBodySchema,
  fundraisingSettingsSchema,
  guestDonationBodySchema,
  publicCampaignSchema,
} from './schema';

const base = '/api/v1/fundraising/orgs/{orgId}';
const route = (
  method: 'get' | 'post' | 'put' | 'patch',
  path: string,
  summary: string,
  response: z.ZodType,
  body?: z.ZodType,
) => ({
  method,
  path,
  summary,
  response,
  tags: ['fundraising'],
  ...(body ? { body } : {}),
});
const openapiRoutes = [
  route(
    'get',
    '/api/v1/fundraising/public/orgs/{orgSlug}/campaigns/{campaignSlug}',
    'View an open public campaign',
    publicCampaignSchema,
  ),
  route(
    'post',
    '/api/v1/fundraising/public/orgs/{orgSlug}/campaigns/{campaignSlug}/donations',
    'Start Turnstile-verified guest donation checkout',
    z.json(),
    guestDonationBodySchema,
  ),
  route(
    'get',
    `${base}/campaigns`,
    'List fundraising campaigns and totals',
    campaignListSchema,
  ),
  route(
    'post',
    `${base}/campaigns`,
    'Create a fundraising campaign',
    campaignSchema,
    campaignBodySchema,
  ),
  route(
    'patch',
    `${base}/campaigns/{campaignId}/status`,
    'Publish, end, or archive a campaign',
    z.json(),
    campaignStateSchema,
  ),
  route(
    'get',
    `${base}/settings`,
    'Read restricted fundraising tax acknowledgment settings',
    fundraisingSettingsSchema,
  ),
  route(
    'put',
    `${base}/settings`,
    'Encrypt and save nonprofit tax acknowledgment settings',
    fundraisingSettingsSchema,
    fundraisingSettingsBodySchema,
  ),
  {
    method: 'get',
    path: '/api/v1/fundraising/preview-checkout/{orgId}/{checkoutSessionId}/complete',
    summary: 'Complete preview donation checkout and redirect to its campaign',
    response: z.null(),
    status: 302,
    public: true,
    tags: ['fundraising'],
  },
  route(
    'get',
    `${base}/donor-statements/{year}`,
    'Read signed-in donor year-end statement',
    donorStatementSchema,
  ),
];

export const moduleDefinition = {
  name: 'fundraising',
  path: '/api/v1/fundraising',
  router: createFundraisingRouter,
  jobs: [],
  permissions: ['fundraising.read', 'fundraising.manage'],
  notificationTypes: [
    'fundraising.donation_receipt',
    'fundraising.campaign_update',
  ],
  errorCodes: ['CHECKOUT_UNAVAILABLE'],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
