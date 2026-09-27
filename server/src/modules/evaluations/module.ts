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
  placementPreferenceSchema,
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
  ['post', '/orgs/{orgId}/programs/{programId}/boards', 'Balance a rec-league board from registrations', boardCreateSchema],
  ['get', '/orgs/{orgId}/programs/{programId}/placement-preferences', 'List placement preferences for a program'],
  ['put', '/orgs/{orgId}/programs/{programId}/placement-preferences', 'Save a participant placement preference', placementPreferenceSchema],
  ['get', '/orgs/{orgId}/boards/{boardId}/offers', 'Offer status per team with next-in-line suggestions'],
  ['post', '/orgs/{orgId}/placements/{placementId}/offers', 'Send a team offer with a deposit', offerSchema],
  ['get', '/orgs/{orgId}/me/offers', 'List offers in the current family'],
  ['get', '/orgs/{orgId}/me/results', 'List shared evaluation results for the family'],
  ['post', '/orgs/{orgId}/offers/{offerId}/accept', 'Accept an offer through registration checkout'],
  ['post', '/orgs/{orgId}/offers/{offerId}/decline', 'Decline an offer', offerDeclineSchema],
  ['post', '/orgs/{orgId}/offers/{offerId}/withdraw', 'Withdraw an unanswered offer'],
] as const;

export const moduleDefinition = {
  name: 'evaluations',
  path: base,
  router: createEvaluationsRouter,
  jobs: [{ name: 'evaluations.expire-offers', cron: '*/15 * * * *', run: runEvaluationOfferExpiry }],
  permissions: ['evaluations.manage', 'evaluations.score', 'evaluations.read'],
  notificationTypes: ['evaluation.offer', 'offer.expiring'],
  errorCodes: [
    'ALREADY_CHECKED_IN',
    'BALANCING_FAILED',
    'BOARD_NOT_DRAFT',
    'CAPACITY_EXCEEDED',
    'CHECKOUT_UNAVAILABLE',
    'COMPLIANCE_REQUIRED',
    'DIVISION_REQUIRED',
    'EVENT_LOCKED',
    'GROUP_NOT_ELIGIBLE',
    'INVALID_DEPOSIT',
    'INVALID_EXPIRY',
    'INVALID_GROUPS',
    'INVALID_RUBRIC',
    'INVALID_SCORE',
    'INVALID_SESSION',
    'NOT_FOUND',
    'OFFER_RACE',
    'PARTICIPANTS_REQUIRED',
    'PLACEMENT_LOCKED',
    'PREFERENCE_CONFLICT',
    'RESULTS_REQUIRED',
    'SCORE_CONFLICT',
    'SPORT_PROFILE_MISMATCH',
    'TEAMS_REQUIRED',
    'VERSION_CONFLICT',
  ],
  openapiRoutes: descriptors.map(([method, suffix, summary, body]) => ({
    method,
    path: `${base}${suffix}`,
    summary,
    response: z.json(),
    ...(body ? { body } : {}),
    tags: ['evaluations'],
  })),
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
