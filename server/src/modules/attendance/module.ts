import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createAttendanceRouter } from './routes';

const json = z.json();
const base = '/api/v1/attendance';
const endpoints = [
  ['get', '/orgs/{orgId}/events/{eventId}', 'List event attendance'],
  [
    'get',
    '/orgs/{orgId}/events/{eventId}/game-day',
    'Get the private coach game-day screen',
  ],
  [
    'put',
    '/orgs/{orgId}/events/{eventId}/people/{personId}/rsvp',
    'Submit a family RSVP',
  ],
  [
    'patch',
    '/orgs/{orgId}/events/{eventId}/people/{personId}/attendance',
    'Record attendance and check-in',
  ],
  [
    'post',
    '/orgs/{orgId}/events/{eventId}/people/{personId}/check-out',
    'Check out an athlete to an authorized pickup person',
  ],
  [
    'put',
    '/orgs/{orgId}/contests/{contestId}/teams/{teamSeasonId}/lineup',
    'Save a contest lineup',
  ],
  ['get', '/orgs/{orgId}/reports', 'Get an attendance report'],
] as const;
const openapiRoutes = endpoints.map(([method, path, summary]) => ({
  method,
  path: `${base}${path}`,
  summary,
  response: json,
  ...(['post', 'put', 'patch'].includes(method) ? { body: json } : {}),
  tags: ['attendance'],
}));

export const moduleDefinition = {
  name: 'attendance',
  path: '/api/v1/attendance',
  router: createAttendanceRouter,
  permissions: [
    'attendance.read',
    'attendance.manage',
    'attendance.rsvp',
    'results.manage',
  ],
  notificationTypes: [],
  errorCodes: ['SCHEDULE_INVALID', 'SCHEDULE_CONFLICT'],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
