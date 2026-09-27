import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createSafetyRouter } from './routes';

const base = '/api/v1/safety/organizations/{orgId}';
const injuryBody = z.strictObject({
  personId: z.uuid(),
  eventId: z.uuid().nullable().optional(),
  occurredAt: z.iso.datetime(),
  bodyPart: z.string().trim().max(100).nullable().optional(),
  injuryType: z.string().trim().max(100).nullable().optional(),
  suspectedConcussion: z.boolean(),
  description: z.string().trim().min(4).max(20_000),
});
const clearanceBody = z.strictObject({
  fileId: z.uuid(),
  providerName: z.string().trim().min(2).max(200),
  clearedOn: z.iso.date(),
});
const clearanceReviewBody = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(2000).optional(),
  version: z.number().int().positive(),
});
const incidentBody = z.strictObject({
  category: z.enum([
    'safety',
    'behavior',
    'safesport_concern',
    'facility',
    'other',
  ]),
  occurredAt: z.iso.datetime(),
  eventId: z.uuid().nullable().optional(),
  peopleInvolved: z.array(z.uuid()).max(100),
  narrative: z.string().trim().min(10).max(20_000),
});
const incidentUpdateBody = z.strictObject({
  status: z.enum(['open', 'under_review', 'closed']),
  resolution: z.string().trim().max(20_000).nullable().optional(),
  version: z.number().int().positive(),
});
type Method = 'get' | 'post' | 'patch';
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
    tags: ['safety'],
    ...(body ? { body } : {}),
  };
}
const openapiRoutes = [
  route('post', '/injuries', 'Report injury', injuryBody),
  route('get', '/people/{personId}/injuries', 'List person injuries'),
  route(
    'post',
    '/injuries/{injuryId}/clearances',
    'Submit return-to-play clearance',
    clearanceBody,
  ),
  route('get', '/clearances/review-queue', 'List clearance reviews'),
  route(
    'post',
    '/clearances/{clearanceId}/review',
    'Review clearance',
    clearanceReviewBody,
  ),
  route('post', '/incidents', 'Report safety incident', incidentBody),
  route('get', '/incidents', 'List safety incidents'),
  route('get', '/incidents/{incidentId}', 'Read safety incident'),
  route(
    'patch',
    '/incidents/{incidentId}',
    'Update safety incident',
    incidentUpdateBody,
  ),
];

export const moduleDefinition = {
  name: 'safety',
  path: '/api/v1/safety',
  router: createSafetyRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [
    'safety.injury_reported',
    'safety.incident_reported',
    'safety.safesport_concern_reported',
  ],
  errorCodes: [],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
