import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createTournamentsRouter } from './routes';

const json = z.json();
const base = '/api/v1/tournaments';
const endpoints = [
  ['get', '/orgs/{orgId}/programs/{programId}', 'List tournament brackets'],
  [
    'post',
    '/orgs/{orgId}/brackets',
    'Create a tournament bracket or pool program',
  ],
  [
    'get',
    '/orgs/{orgId}/brackets/{bracketId}',
    'Get bracket, pools, matches, and check-in status',
  ],
  [
    'post',
    '/orgs/{orgId}/brackets/{bracketId}/generate',
    'Generate pool or elimination matches',
  ],
  [
    'post',
    '/orgs/{orgId}/brackets/{bracketId}/entries/{entryId}/check-in',
    'Check in a tournament team',
  ],
  [
    'post',
    '/orgs/{orgId}/brackets/{bracketId}/matches/{matchId}/contest',
    'Link a match to its contest',
  ],
  [
    'post',
    '/orgs/{orgId}/brackets/{bracketId}/pools',
    'Create a round-robin pool',
  ],
  [
    'post',
    '/orgs/{orgId}/brackets/pool-seeds',
    'Seed bracket entries from pool standings',
  ],
  [
    'get',
    '/public/orgs/{orgSlug}/brackets/{bracketId}',
    'Read a public tournament bracket',
  ],
] as const;
const openapiRoutes = endpoints.map(([method, path, summary]) => ({
  method,
  path: `${base}${path}`,
  summary,
  response: json,
  ...(['post', 'put', 'patch'].includes(method) ? { body: json } : {}),
  ...(path.startsWith('/public/') ? { public: true } : {}),
  tags: ['tournaments'],
}));

export const moduleDefinition = {
  name: 'tournaments',
  path: '/api/v1/tournaments',
  router: createTournamentsRouter,
  permissions: ['tournaments.manage', 'results.read'],
  notificationTypes: [],
  errorCodes: ['SCHEDULE_INVALID', 'SCHEDULE_CONFLICT'],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
