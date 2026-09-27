import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createDisciplineRouter } from './routes';

const base = '/api/v1/discipline/organizations/{orgId}';
const disciplineBody = z.strictObject({
  personId: z.uuid().nullable().optional(),
  teamSeasonId: z.uuid().nullable().optional(),
  contestId: z.uuid().nullable().optional(),
  type: z.enum([
    'caution',
    'send_off',
    'ejection',
    'technical',
    'suspension',
    'fine',
    'other',
  ]),
  description: z.string().trim().min(3).max(4000),
  suspensionGames: z.number().int().min(0).max(100).nullable().optional(),
  suspensionUntil: z.iso.date().nullable().optional(),
});
const updateBody = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('serve_games'),
    games: z.number().int().min(1).max(100),
    version: z.number().int().positive(),
  }),
  z.strictObject({
    action: z.literal('appeal'),
    version: z.number().int().positive(),
  }),
  z.strictObject({
    action: z.literal('overturn'),
    version: z.number().int().positive(),
  }),
]);
const openapiRoutes = [
  {
    method: 'post',
    path: `${base}/records`,
    summary: 'Record disciplinary action',
    body: disciplineBody,
    response: z.json(),
    tags: ['discipline'],
  },
  {
    method: 'get',
    path: `${base}/people/{personId}`,
    summary: 'List person disciplinary records',
    response: z.json(),
    tags: ['discipline'],
  },
  {
    method: 'get',
    path: base,
    summary: 'List organization disciplinary records',
    response: z.json(),
    tags: ['discipline'],
  },
  {
    method: 'patch',
    path: `${base}/records/{recordId}`,
    summary: 'Update disciplinary action',
    body: updateBody,
    response: z.json(),
    tags: ['discipline'],
  },
];

export const moduleDefinition = {
  name: 'discipline',
  path: '/api/v1/discipline',
  router: createDisciplineRouter,
  jobs: [],
  permissions: [],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
