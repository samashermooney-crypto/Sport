import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createContestsRouter } from './routes';

const json = z.json();
const base = '/api/v1/contests';
const endpoints = [
  [
    'get',
    '/orgs/{orgId}/events/{eventId}/results',
    'List event contest results',
  ],
  [
    'post',
    '/orgs/{orgId}/events/{eventId}/contests',
    'Create a format-versioned contest',
  ],
  [
    'get',
    '/orgs/{orgId}/contests/{contestId}',
    'Get contest and result history',
  ],
  [
    'post',
    '/orgs/{orgId}/contests/{contestId}/results',
    'Submit or finalize contest results',
  ],
  [
    'put',
    '/orgs/{orgId}/contests/{contestId}/meet-assignments',
    'Assign timed meet participants to heats and lanes',
  ],
  [
    'post',
    '/orgs/{orgId}/contests/{contestId}/confirm',
    'Confirm an opponent result',
  ],
  [
    'post',
    '/orgs/{orgId}/contests/{contestId}/disputes',
    'Dispute a contest result',
  ],
  ['get', '/orgs/{orgId}/teams/{teamSeasonId}/stats', 'List team statistics'],
  [
    'get',
    '/orgs/{orgId}/programs/{programId}/stats/settings',
    'Get program statistic settings',
  ],
  [
    'put',
    '/orgs/{orgId}/programs/{programId}/stats/settings',
    'Update program statistic settings',
  ],
  [
    'get',
    '/orgs/{orgId}/programs/{programId}/stats/leaders',
    'List program or division statistic leaders',
  ],
  [
    'get',
    '/orgs/{orgId}/people/{personId}/personal-bests',
    'List athlete personal bests',
  ],
  [
    'get',
    '/public/orgs/{orgSlug}/contests/{contestId}/live',
    'Read public live contest results',
  ],
] as const;
const openapiRoutes = endpoints.map(([method, path, summary]) => ({
  method,
  path: `${base}${path}`,
  summary,
  response: json,
  ...(['post', 'put', 'patch'].includes(method) ? { body: json } : {}),
  ...(path.startsWith('/public/') ? { public: true } : {}),
  tags: ['contests'],
}));
const leadersRoute = openapiRoutes.find((route) =>
  route.path.endsWith('/stats/leaders'),
);
if (leadersRoute)
  Object.assign(leadersRoute, {
    query: { divisionId: z.uuid().optional() },
  });

export const moduleDefinition = {
  name: 'contests',
  path: '/api/v1/contests',
  router: createContestsRouter,
  permissions: ['results.read', 'results.manage'],
  notificationTypes: [],
  errorCodes: ['SCHEDULE_INVALID', 'SCHEDULE_CONFLICT'],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
