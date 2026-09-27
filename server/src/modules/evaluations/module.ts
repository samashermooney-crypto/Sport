import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { runEvaluationOfferExpiry } from './jobs';
import { createEvaluationsRouter } from './routes';
import {
  boardCreateSchema,
  evaluationCreateSchema,
  evaluationSessionSchema,
  offerDeclineSchema,
  offerSchema,
  participantSchema,
  placementMoveSchema,
  scoreSchema,
} from './schemas';

const base = '/api/v1/evaluations';
const descriptors = [
  ['get', '/orgs/{orgId}/events', 'List evaluation events'],
  ['post', '/orgs/{orgId}/events', 'Create an evaluation event', evaluationCreateSchema],
  ['get', '/orgs/{orgId}/events/{eventId}/setup', 'Read evaluation groups, sessions and check-in list'],
  ['post', '/orgs/{orgId}/events/{eventId}/sessions', 'Create an evaluation session', evaluationSessionSchema],
  ['post', '/orgs/{orgId}/events/{eventId}/participants', 'Assign a participant and bib', participantSchema],
  ['get', '/orgs/{orgId}/events/{eventId}/scoring-sheet', 'Read an assigned evaluator scoring sheet'],
  ['post', '/orgs/{orgId}/events/{eventId}/scores', 'Idempotently save an evaluator score', scoreSchema],
  ['post', '/orgs/{orgId}/events/{eventId}/compute-results', 'Compute normalized rankings'],
  ['get', '/orgs/{orgId}/events/{eventId}/consistency', 'Read evaluator consistency metrics'],
  ['get', '/orgs/{orgId}/events/{eventId}/results', 'Read normalized evaluation results'],
  ['post', '/orgs/{orgId}/events/{eventId}/boards', 'Create and balance a placement board', boardCreateSchema],
  ['post', '/orgs/{orgId}/boards/{boardId}/placements/move', 'Move a player with version check', placementMoveSchema],
  ['post', '/orgs/{orgId}/boards/{boardId}/publish', 'Publish a placement board'],
  ['post', '/orgs/{orgId}/placements/{placementId}/offers', 'Send a team offer with a deposit', offerSchema],
  ['get', '/orgs/{orgId}/me/offers', 'List offers in the current family'],
  ['post', '/orgs/{orgId}/offers/{offerId}/accept', 'Accept an offer through registration checkout'],
  ['post', '/orgs/{orgId}/offers/{offerId}/decline', 'Decline an offer', offerDeclineSchema],
] as const;

export const moduleDefinition = {
  name: 'evaluations',
  path: base,
  router: createEvaluationsRouter,
  jobs: [{ name: 'evaluations.expire-offers', cron: '*/15 * * * *', run: runEvaluationOfferExpiry }],
  permissions: ['evaluations.manage', 'evaluations.score', 'evaluations.read'],
  notificationTypes: ['evaluation.offer'],
  errorCodes: ['INVALID_RUBRIC', 'INVALID_SCORE', 'COMPLIANCE_REQUIRED', 'VERSION_CONFLICT'],
  openapiRoutes: descriptors.map(([method, suffix, summary, body]) => ({
    method,
    path: `${base}${suffix}`,
    summary,
    response: z.json(),
    ...(body ? { body } : {}),
    tags: ['evaluations'],
  })),
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
