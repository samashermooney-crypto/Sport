import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createStandingsRouter } from './routes';
import { runStandingsDirtyJob } from './service';

const json = z.json();
const base = '/api/v1/standings';
const endpoints = [
  [
    'get',
    '/orgs/{orgId}/programs/{programId}/standings',
    'Read program standings',
  ],
  [
    'post',
    '/orgs/{orgId}/programs/{programId}/standings/refresh',
    'Refresh program standings snapshot',
  ],
  [
    'put',
    '/orgs/{orgId}/programs/{programId}/standings/config',
    'Configure program standings',
  ],
  [
    'get',
    '/orgs/{orgId}/divisions/{divisionId}/standings',
    'Read division standings',
  ],
  [
    'post',
    '/orgs/{orgId}/divisions/{divisionId}/standings/refresh',
    'Refresh division standings snapshot',
  ],
  [
    'put',
    '/orgs/{orgId}/divisions/{divisionId}/standings/config',
    'Configure division standings',
  ],
  [
    'get',
    '/public/orgs/{orgSlug}/programs/{programId}',
    'Read public program standings',
  ],
  [
    'get',
    '/public/orgs/{orgSlug}/divisions/{divisionId}',
    'Read public division standings',
  ],
  [
    'get',
    '/orgs/{orgId}/programs/{programId}/season-surveys',
    'List end-of-season surveys',
  ],
  [
    'get',
    '/orgs/{orgId}/season-surveys',
    'List open surveys for a verified family account',
  ],
  [
    'post',
    '/orgs/{orgId}/programs/{programId}/season-surveys',
    'Create an end-of-season family survey',
  ],
  [
    'patch',
    '/orgs/{orgId}/season-surveys/{campaignId}',
    'Open, close, or archive a family survey',
  ],
  [
    'post',
    '/orgs/{orgId}/season-surveys/{campaignId}/responses',
    'Submit a verified family survey response',
  ],
  [
    'get',
    '/orgs/{orgId}/season-surveys/{campaignId}/results',
    'Read family survey summary and comments',
  ],
  [
    'put',
    '/orgs/{orgId}/team-seasons/{teamSeasonId}/player-ratings',
    'Capture coach player ratings for next-season balancing',
  ],
  [
    'get',
    '/orgs/{orgId}/programs/{programId}/prior-player-ratings',
    'Read coach ratings from the prior season for team balancing',
  ],
  [
    'get',
    '/orgs/{orgId}/programs/{programId}/season-awards',
    'List season awards',
  ],
  [
    'post',
    '/orgs/{orgId}/programs/{programId}/season-awards',
    'Issue an individual or team season award',
  ],
  [
    'post',
    '/orgs/{orgId}/seasons/{seasonId}/archive',
    'Archive a completed season',
  ],
] as const;
const openapiRoutes = endpoints.map(([method, path, summary]) => ({
  method,
  path: `${base}${path}`,
  summary,
  response: json,
  ...(['post', 'put', 'patch'].includes(method) ? { body: json } : {}),
  ...(path.startsWith('/public/') ? { public: true } : {}),
  tags: ['standings'],
}));

export const moduleDefinition = {
  name: 'standings',
  path: '/api/v1/standings',
  router: createStandingsRouter,
  jobs: [
    {
      name: 'standings.recompute-dirty',
      cron: '* * * * *',
      run: runStandingsDirtyJob,
    },
  ],
  permissions: ['results.read', 'results.manage', 'schedule.manage'],
  notificationTypes: [],
  errorCodes: ['SCHEDULE_INVALID', 'SCHEDULE_CONFLICT'],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
