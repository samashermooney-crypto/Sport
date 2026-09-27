import { z } from 'zod';

/**
 * Phase 13 federation contracts. Shared between the server module
 * (`server/src/modules/federation`) and the console feature
 * (`web/src/console/federation`).
 */

export const federationRelationshipTypeSchema = z.enum([
  'member_club',
  'affiliate',
]);
export type FederationRelationshipType = z.infer<
  typeof federationRelationshipTypeSchema
>;

export const federationRelationshipStatusSchema = z.enum([
  'invited',
  'active',
  'suspended',
  'ended',
]);
export type FederationRelationshipStatus = z.infer<
  typeof federationRelationshipStatusSchema
>;

/**
 * The complete allow-list of datasets a parent (league/association) may read
 * from a member organization. Medical data is intentionally absent: it is
 * never shareable through federation relationships.
 */
export const federationSharingSchema = z
  .strictObject({
    rosters: z.boolean().optional(),
    compliance_status: z.boolean().optional(),
    team_entries: z.boolean().optional(),
    discipline: z.boolean().optional(),
  })
  .refine(
    (value) => !('medical' in value),
    'Medical data is never shareable through federation agreements',
  );
export type FederationSharing = z.infer<typeof federationSharingSchema>;

export const federationSharingKeySchema = z.enum([
  'rosters',
  'compliance_status',
  'team_entries',
  'discipline',
]);
export type FederationSharingKey = z.infer<typeof federationSharingKeySchema>;

export const federationRelationshipSchema = z.strictObject({
  id: z.uuid(),
  parentOrgId: z.uuid(),
  parentOrgName: z.string(),
  childOrgId: z.uuid(),
  childOrgName: z.string(),
  type: federationRelationshipTypeSchema,
  initiator: z.enum(['parent', 'child']),
  status: federationRelationshipStatusSchema,
  dataSharing: federationSharingSchema,
  pendingDataSharing: federationSharingSchema.nullable(),
  pendingSharingByMe: z.boolean(),
  note: z.string().nullable(),
  respondedAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type FederationRelationship = z.infer<
  typeof federationRelationshipSchema
>;

export const createRelationshipBodySchema = z.strictObject({
  direction: z.enum(['invite', 'request']),
  organizationId: z.uuid(),
  type: federationRelationshipTypeSchema.default('member_club'),
  dataSharing: federationSharingSchema.default({}),
  note: z.string().trim().max(2000).optional(),
});

export const sharingProposalBodySchema = z.strictObject({
  dataSharing: federationSharingSchema,
  version: z.number().int().positive(),
});

/** Allow-listed player row inside a roster snapshot. */
export const rosterSnapshotPlayerSchema = z.strictObject({
  personRef: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  ageLabel: z.string().nullable(),
  jerseyNumber: z.string().nullable(),
  positions: z.array(z.string()),
  cardNumber: z.string().nullable(),
  photoAvailable: z.boolean(),
});
export type RosterSnapshotPlayer = z.infer<typeof rosterSnapshotPlayerSchema>;

export const federationMemberPhotoSchema = z.strictObject({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  base64: z.string().min(1).max(6_000_000),
});

export const submitEntryBodySchema = z.strictObject({
  leagueOrgId: z.uuid(),
  programId: z.uuid(),
  divisionId: z.uuid(),
  teamSeasonId: z.uuid(),
  captainPersonId: z.uuid().optional(),
  contactAccountId: z.uuid().optional(),
  seedHint: z.number().int().min(1).max(1000).optional(),
  note: z.string().trim().max(2000).optional(),
});

export const reviewEntryBodySchema = z.strictObject({
  action: z.enum(['accept', 'waitlist', 'decline']),
  reason: z.string().trim().max(2000).optional(),
  version: z.number().int().positive(),
});

export const rosterWindowBodySchema = z.strictObject({
  submitBy: z.iso.datetime(),
  freezeAt: z.iso.datetime().nullable().optional(),
});

export const contributionBodySchema = z.strictObject({
  relationshipId: z.uuid(),
  spaceId: z.uuid(),
  windows: z
    .array(
      z.strictObject({
        startsAt: z.iso.datetime(),
        endsAt: z.iso.datetime(),
      }),
    )
    .min(1)
    .max(200),
  notes: z.string().trim().max(1000).optional(),
});

export const scheduleRunBodySchema = z.strictObject({
  programId: z.uuid(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  rounds: z.number().int().min(1).max(20).default(1),
  earliestDate: z.iso.date(),
  latestDate: z.iso.date(),
  gameMinutes: z.number().int().min(15).max(300).default(60),
  bufferMinutes: z.number().int().min(0).max(120).default(0),
  timeWindows: z
    .array(
      z.strictObject({
        weekday: z.number().int().min(1).max(7),
        startMinute: z.number().int().min(0).max(1439),
        endMinute: z.number().int().min(1).max(1440),
      }),
    )
    .min(1)
    .max(50),
  maxGamesPerDay: z.number().int().min(1).max(10).optional(),
  maxGamesPerWeek: z.number().int().min(1).max(14).optional(),
  minRestDays: z.number().int().min(0).max(14).optional(),
});

export const contestResultBodySchema = z.strictObject({
  results: z
    .array(
      z.strictObject({
        externalTeamId: z.uuid(),
        score: z.number().min(0).max(10000).nullable().optional(),
        outcome: z.enum(['win', 'loss', 'tie', 'none']).optional(),
        status: z
          .enum([
            'ok',
            'dnf',
            'dns',
            'dq',
            'forfeit_win',
            'forfeit_loss',
            'no_contest',
          ])
          .default('ok'),
      }),
    )
    .min(1)
    .max(20),
  finalize: z.boolean().default(true),
  reason: z.string().trim().max(1000).optional(),
  version: z.number().int().positive().optional(),
});

export const federationDisciplineBodySchema = z.strictObject({
  memberOrgId: z.uuid(),
  contestId: z.uuid().nullable().optional(),
  externalTeamId: z.uuid().nullable().optional(),
  subjectType: z.enum(['team', 'person']),
  personRef: z.uuid().nullable().optional(),
  personLabel: z.string().trim().min(1).max(200).nullable().optional(),
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

export const federationDisciplineUpdateSchema = z.discriminatedUnion('action', [
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

export const refereeBodySchema = z.strictObject({
  personId: z.uuid(),
  grade: z.string().trim().max(50).optional(),
  level: z.string().trim().max(50).optional(),
  sports: z.array(z.uuid()).max(20).optional(),
  maxGamesPerDay: z.number().int().min(1).max(20).optional(),
  homeArea: z.string().trim().max(200).optional(),
});

export const refereeAssignmentBodySchema = z.strictObject({
  personId: z.uuid(),
  positionKey: z.string().trim().min(1).max(50),
  feeCents: z.number().int().min(0).max(100_000_000).default(0),
  mileageCents: z.number().int().min(0).max(100_000_000).default(0),
});

export const assignmentUpdateSchema = z.strictObject({
  action: z.enum(['accept', 'decline', 'confirm', 'cancel', 'no_show']),
  version: z.number().int().positive().optional(),
});

export const memberPayerBodySchema = z.strictObject({
  leagueOrgId: z.uuid(),
  billingAccountId: z.uuid(),
});

export const feeAssessmentBodySchema = z.strictObject({
  memberOrgId: z.uuid(),
  programId: z.uuid().optional(),
  teamEntryId: z.uuid().optional(),
  description: z.string().trim().min(1).max(500),
  amountCents: z.number().int().min(1).max(1_000_000_000),
  dueOn: z.iso.date().optional(),
});

export const feeActionBodySchema = z.strictObject({
  action: z.enum(['issue', 'void']),
  reason: z.string().trim().max(1000).optional(),
  version: z.number().int().positive().optional(),
});
