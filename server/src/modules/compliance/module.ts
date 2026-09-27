import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createComplianceRouter } from './routes';
import {
  backgroundAdjudicationSchema,
  backgroundConsentSchema,
  backgroundResultSchema,
  backgroundSettingsSchema,
  cardBodySchema,
  cardStatusSchema,
  complianceOverrideSchema,
  credentialBodySchema,
  credentialRequirementSchema,
  credentialReviewSchema,
  credentialRevokeSchema,
  credentialSubmissionUpdateSchema,
  credentialTypeUpdateSchema,
  requirementUpdateSchema,
} from './schemas';

type Method = 'get' | 'post' | 'patch';
const base = '/api/v1/compliance';
function route(
  method: Method,
  suffix: string,
  summary: string,
  body?: z.ZodType,
) {
  return {
    method,
    path: `${base}${suffix}`,
    summary,
    response: z.json(),
    tags: ['compliance'],
    ...(body ? { body } : {}),
  };
}

const openapiRoutes = [
  route('get', '/organizations/{orgId}/dashboard', 'Read compliance dashboard'),
  route(
    'get',
    '/organizations/{orgId}/credential-types',
    'List credential types',
  ),
  route(
    'patch',
    '/organizations/{orgId}/credential-types/{credentialTypeId}',
    'Update credential type',
    credentialTypeUpdateSchema,
  ),
  route(
    'get',
    '/organizations/{orgId}/requirements',
    'List role credential requirements',
  ),
  route(
    'post',
    '/organizations/{orgId}/requirements',
    'Create role credential requirement',
    credentialRequirementSchema,
  ),
  route(
    'patch',
    '/organizations/{orgId}/requirements/{requirementId}',
    'Update role credential requirement',
    requirementUpdateSchema,
  ),
  route(
    'post',
    '/organizations/{orgId}/overrides',
    'Grant a time-limited compliance override',
    complianceOverrideSchema,
  ),
  route(
    'get',
    '/organizations/{orgId}/credentials/review-queue',
    'List credential reviews',
  ),
  route(
    'post',
    '/organizations/{orgId}/credentials/{credentialId}/review',
    'Review submitted credential',
    credentialReviewSchema,
  ),
  route(
    'get',
    '/organizations/{orgId}/people/{personId}/credentials',
    'List person credentials',
  ),
  route(
    'post',
    '/organizations/{orgId}/credentials',
    'Submit person credential',
    credentialBodySchema,
  ),
  route(
    'patch',
    '/organizations/{orgId}/credentials/{credentialId}',
    'Correct submitted credential',
    credentialSubmissionUpdateSchema,
  ),
  route(
    'post',
    '/organizations/{orgId}/credentials/{credentialId}/revoke',
    'Revoke person credential',
    credentialRevokeSchema,
  ),
  route(
    'get',
    '/organizations/{orgId}/background-check-settings',
    'Read background-check settings',
  ),
  route(
    'patch',
    '/organizations/{orgId}/background-check-settings',
    'Update background-check settings',
    backgroundSettingsSchema,
  ),
  route(
    'get',
    '/organizations/{orgId}/background-checks',
    'List background checks',
  ),
  route(
    'get',
    '/organizations/{orgId}/my-background-checks',
    'List own background checks',
  ),
  route(
    'get',
    '/organizations/{orgId}/background-checks/{orderId}',
    'Read background-check details',
  ),
  route(
    'post',
    '/organizations/{orgId}/background-checks',
    'Begin background check',
    backgroundConsentSchema,
  ),
  route(
    'post',
    '/organizations/{orgId}/background-checks/{orderId}/manual-result',
    'Record manual background result',
    backgroundResultSchema,
  ),
  route(
    'post',
    '/organizations/{orgId}/background-checks/{orderId}/pre-adverse-notice',
    'Send pre-adverse notice',
  ),
  route(
    'post',
    '/organizations/{orgId}/background-checks/{orderId}/adverse-notice',
    'Send adverse notice',
  ),
  route(
    'post',
    '/organizations/{orgId}/background-checks/{orderId}/adjudication',
    'Adjudicate background check',
    backgroundAdjudicationSchema,
  ),
  route(
    'post',
    '/organizations/{orgId}/background-checks/{orderId}/disputes',
    'Submit background-check dispute',
    z.strictObject({ statement: z.string().trim().min(10).max(20_000) }),
  ),
  route(
    'get',
    '/organizations/{orgId}/background-checks/{orderId}/disputes',
    'List own background-check disputes',
  ),
  route(
    'get',
    '/organizations/{orgId}/background-check-disputes',
    'List background-check disputes',
  ),
  route(
    'patch',
    '/organizations/{orgId}/background-check-disputes/{disputeId}',
    'Resolve background-check dispute',
    z.strictObject({
      resolution: z.string().trim().min(10).max(20_000),
      version: z.number().int().positive(),
    }),
  ),
  route(
    'post',
    '/organizations/{orgId}/cards',
    'Create player or staff card',
    cardBodySchema,
  ),
  route(
    'get',
    '/organizations/{orgId}/people/{personId}/cards',
    'List person cards',
  ),
  route(
    'patch',
    '/organizations/{orgId}/cards/{cardId}',
    'Revoke player or staff card',
    cardStatusSchema,
  ),
  {
    ...route('get', '/cards/verify/{token}', 'Verify public card'),
    public: true,
  },
  {
    ...route('get', '/cards/verify/{token}/photo', 'Read public card photo'),
    public: true,
    response: z.string(),
    contentType: 'application/octet-stream',
    binary: true,
  },
  {
    ...route('post', '/webhooks/checkr', 'Receive Checkr webhook'),
    public: true,
    body: z.string(),
    contentType: 'application/json',
  },
];

const configSchema = z
  .object({
    CHECKR_ENABLED: z.enum(['true', 'false']).optional(),
    CHECKR_API_KEY: z.string().optional(),
    CHECKR_BASE_URL: z.string().optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  })
  .superRefine((value, context) => {
    if (value.CHECKR_ENABLED === 'true' && !value.CHECKR_API_KEY)
      context.addIssue({
        code: 'custom',
        path: ['CHECKR_API_KEY'],
        message: 'Checkr requires a server-side API key',
      });
    if (
      value.NODE_ENV !== 'production' &&
      value.CHECKR_BASE_URL === 'https://api.checkr.com'
    )
      context.addIssue({
        code: 'custom',
        path: ['CHECKR_BASE_URL'],
        message: 'Local and test environments must use Checkr staging',
      });
  });

export const moduleDefinition = {
  name: 'compliance',
  path: '/api/v1/compliance',
  router: createComplianceRouter,
  jobs: [{ name: 'credentials.expiry' }],
  permissions: [],
  notificationTypes: [
    'compliance.credential_expired',
    'compliance.credential_expiry_reminder',
    'compliance.credential_rejected',
    'compliance.credential_revoked',
    'compliance.credential_verified',
    'compliance.role_activated',
    'compliance.role_demoted',
    'compliance.background_check_adverse_notice',
  ],
  errorCodes: [],
  configSchema,
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
