import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { runEvaluationOfferExpiry } from './jobs';
import { createEvaluationsRouter } from './routes';
import {
  boardCreateSchema,
  evaluationEvaluatorSchema,
  evaluationCreateSchema,
  evaluationSessionSchema,
  familyPlacementPreferenceSchema,
  offerDeclineSchema,
  offerSchema,
  participantSchema,
  placementMoveSchema,
  placementLockSchema,
  placementPreferenceSchema,
  participantCheckInSchema,
  scoreSchema,
} from './schemas';

const base = '/api/v1/evaluations';
const descriptors = [
  ['get', '/orgs/{orgId}/events', 'List evaluation events'],
  [
    'get',
    '/orgs/{orgId}/programs',
    'List programs, divisions, offerings and sport rubrics',
  ],
  [
    'get',
    '/orgs/{orgId}/evaluator-candidates',
    'List active evaluator-role members',
  ],
  [
    'post',
    '/orgs/{orgId}/events',
    'Create an evaluation event',
    evaluationCreateSchema,
  ],
  [
    'get',
    '/orgs/{orgId}/events/{eventId}/setup',
    'Read evaluation groups, sessions and check-in list',
  ],
  [
    'get',
    '/orgs/{orgId}/events/{eventId}/registrants',
    'List confirmed tryout registrants',
  ],
  [
    'post',
    '/orgs/{orgId}/events/{eventId}/sessions',
    'Create an evaluation session',
    evaluationSessionSchema,
  ],
  [
    'post',
    '/orgs/{orgId}/events/{eventId}/evaluators',
    'Assign a compliant evaluator to a session',
    evaluationEvaluatorSchema,
  ],
  [
    'post',
    '/orgs/{orgId}/events/{eventId}/participants',
    'Assign a participant and bib',
    participantSchema,
  ],
  [
    'post',
    '/orgs/{orgId}/participants/{participantId}/check-in',
    'Check in a participant',
    participantCheckInSchema,
  ],
  [
    'get',
    '/orgs/{orgId}/events/{eventId}/scoring-sheet',
    'Read an assigned evaluator scoring sheet',
  ],
  [
    'post',
    '/orgs/{orgId}/events/{eventId}/scores',
    'Idempotently save an evaluator score',
    scoreSchema,
  ],
  [
    'post',
    '/orgs/{orgId}/events/{eventId}/compute-results',
    'Compute normalized rankings',
  ],
  [
    'get',
    '/orgs/{orgId}/events/{eventId}/consistency',
    'Read evaluator consistency metrics',
  ],
  [
    'get',
    '/orgs/{orgId}/events/{eventId}/results',
    'Read normalized evaluation results',
  ],
  [
    'post',
    '/orgs/{orgId}/events/{eventId}/boards',
    'Create and balance a placement board',
    boardCreateSchema,
  ],
  [
    'post',
    '/orgs/{orgId}/boards/{boardId}/placements/move',
    'Move a player with version check',
    placementMoveSchema,
  ],
  [
    'post',
    '/orgs/{orgId}/boards/{boardId}/placements/{personId}/lock',
    'Lock a player placement',
    placementLockSchema,
  ],
  [
    'post',
    '/orgs/{orgId}/boards/{boardId}/publish',
    'Publish a placement board',
  ],
  [
    'post',
    '/orgs/{orgId}/programs/{programId}/boards',
    'Balance a rec-league board from registrations',
    boardCreateSchema,
  ],
  [
    'get',
    '/orgs/{orgId}/programs/{programId}/placement-preferences',
    'List placement preferences for a program',
  ],
  [
    'put',
    '/orgs/{orgId}/programs/{programId}/placement-preferences',
    'Save a participant placement preference',
    placementPreferenceSchema,
  ],
  [
    'get',
    '/orgs/{orgId}/boards/{boardId}/offers',
    'Offer status per team with next-in-line suggestions',
  ],
  [
    'get',
    '/orgs/{orgId}/boards/{boardId}',
    'Read a placement board and its saved assignments',
  ],
  [
    'post',
    '/orgs/{orgId}/placements/{placementId}/offers',
    'Send a team offer with a deposit',
    offerSchema,
  ],
  ['get', '/orgs/{orgId}/me/offers', 'List offers in the current family'],
  [
    'get',
    '/orgs/{orgId}/me/placement-programs',
    'List the family’s eligible placement programs',
  ],
  [
    'put',
    '/orgs/{orgId}/me/programs/{programId}/placement-preference',
    'Save a family team placement preference',
    familyPlacementPreferenceSchema,
  ],
  [
    'get',
    '/orgs/{orgId}/me/results',
    'List shared evaluation results for the family',
  ],
  [
    'post',
    '/orgs/{orgId}/offers/{offerId}/accept',
    'Accept an offer through registration checkout',
  ],
  [
    'post',
    '/orgs/{orgId}/offers/{offerId}/decline',
    'Decline an offer',
    offerDeclineSchema,
  ],
  [
    'post',
    '/orgs/{orgId}/offers/{offerId}/withdraw',
    'Withdraw an unanswered offer',
  ],
  [
    'post',
    '/orgs/{orgId}/events/{eventId}/export.csv',
    'Export evaluation results as CSV',
    undefined,
    { response: z.string(), contentType: 'text/csv' },
  ],
] as const;

export const moduleDefinition = {
  name: 'evaluations',
  path: base,
  router: createEvaluationsRouter,
  jobs: [
    {
      name: 'evaluations.expire-offers',
      cron: '*/15 * * * *',
      run: runEvaluationOfferExpiry,
    },
  ],
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
    'INVALID_TARGET_PROGRAM',
    'NOT_FOUND',
    'OFFER_RACE',
    'OFFER_AMOUNT_MISMATCH',
    'PARTICIPANTS_REQUIRED',
    'PLACEMENT_LOCKED',
    'PREFERENCE_CONFLICT',
    'RESULTS_REQUIRED',
    'SCORE_CONFLICT',
    'SPORT_PROFILE_MISMATCH',
    'TEAMS_REQUIRED',
    'VERSION_CONFLICT',
  ],
  openapiRoutes: descriptors.map(([method, suffix, summary, body, extra]) => ({
    method,
    path: `${base}${suffix}`,
    summary,
    response: extra?.response ?? z.json(),
    ...(body ? { body } : {}),
    ...(extra?.contentType ? { contentType: extra.contentType } : {}),
    tags: ['evaluations'],
  })),
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
