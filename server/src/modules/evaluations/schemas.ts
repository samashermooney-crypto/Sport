import { z } from 'zod';

const uuid = z.uuid();
const criterion = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().trim().min(1).max(120),
  weight: z.number().positive().max(100),
  scaleMin: z.number(),
  scaleMax: z.number(),
  positionSpecific: z.boolean().default(false),
  positionKeys: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
});
const group = z.strictObject({
  name: z.string().trim().min(1).max(100),
  ageMinMonths: z.number().int().min(0).max(240).nullable().default(null),
  ageMaxMonths: z.number().int().min(0).max(240).nullable().default(null),
  gender: z.enum(['female', 'male', 'open']).nullable().default(null),
  positionKeys: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
});

export const evaluationCreateSchema = z.strictObject({
  tryoutProgramId: uuid,
  targetProgramId: uuid,
  name: z.string().trim().min(1).max(160),
  normalization: z
    .enum(['none', 'z_score_per_evaluator'])
    .default('z_score_per_evaluator'),
  shareResultsWithFamilies: z.boolean().default(false),
  criteria: z.array(criterion).min(1).max(50),
  groups: z.array(group).min(1).max(100),
});

export const evaluationSessionSchema = z.strictObject({
  groupId: uuid.nullable().default(null),
  name: z.string().trim().min(1).max(120),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  timezone: z.string().trim().min(1).max(100),
  facilityId: uuid.nullable().default(null),
  capacity: z.number().int().positive().nullable().default(null),
});

export const participantSchema = z.strictObject({
  personId: uuid,
  groupId: uuid.nullable().default(null),
  sessionId: uuid.nullable().default(null),
  registrationId: uuid.nullable().default(null),
  positionKeys: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
});

export const scoreSchema = z.strictObject({
  participantId: uuid,
  criterionId: uuid,
  score: z.number(),
  notes: z.string().max(4000).nullable().default(null),
  clientMutationId: uuid,
});

export const boardCreateSchema = z.strictObject({
  divisionId: uuid.nullable().default(null),
  seed: z.number().int().min(0).max(2_147_483_647),
  siblingsTogether: z.boolean().default(false),
  returningStay: z.boolean().default(false),
});

export const placementMoveSchema = z.strictObject({
  personId: uuid,
  teamSeasonId: uuid,
  expectedVersion: z.number().int().positive(),
});

export const offerSchema = z.strictObject({
  placementId: uuid,
  offeringId: uuid,
  amountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  depositCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.iso.datetime(),
  message: z.string().trim().max(4000).nullable().default(null),
});

export const offerDeclineSchema = z.strictObject({
  reason: z.string().trim().min(1).max(2000),
  expectedVersion: z.number().int().positive(),
});

export type EvaluationCreate = z.infer<typeof evaluationCreateSchema>;
export type EvaluationSessionInput = z.infer<typeof evaluationSessionSchema>;
export type ParticipantInput = z.infer<typeof participantSchema>;
export type ScoreInput = z.infer<typeof scoreSchema>;
export type BoardCreateInput = z.infer<typeof boardCreateSchema>;
