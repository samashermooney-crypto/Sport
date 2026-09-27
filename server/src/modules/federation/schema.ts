import { z } from 'zod';

const uuid = z.uuid();
export const dataSharingSchema = z.strictObject({
  rosters: z.boolean(),
  staffCompliance: z.boolean(),
  availability: z.boolean(),
  discipline: z.boolean(),
});
export const relationshipInviteSchema = z.strictObject({
  childSlug: z.string().trim().min(2).max(80).optional(),
  childOwnerEmail: z.email().optional(),
  dataSharing: dataSharingSchema.default({
    rosters: false,
    staffCompliance: false,
    availability: false,
    discipline: false,
  }),
}).refine((value) => Boolean(value.childSlug) !== Boolean(value.childOwnerEmail), {
  message: 'Choose the child organization by slug or owner email',
});
export const relationshipRequestSchema = z.strictObject({
  parentSlug: z.string().trim().min(2).max(80),
  dataSharing: dataSharingSchema.default({
    rosters: false,
    staffCompliance: false,
    availability: false,
    discipline: false,
  }),
});
export const relationshipDataSharingBodySchema = z.strictObject({
  dataSharing: dataSharingSchema,
});
export const federationProgramBodySchema = z.strictObject({
  programId: uuid,
  rosterSubmissionDeadline: z.iso.datetime({ offset: true }),
  entryFeeCents: z.number().int().min(0).max(100_000_000).default(0),
  feeDueOn: z.iso.date().nullable().optional(),
});
export const teamEntryBodySchema = z.strictObject({
  teamSeasonId: uuid,
});
export const availabilityBodySchema = z.strictObject({
  facilityId: uuid,
  spaceId: uuid.nullable().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
}).refine((value) => new Date(value.startsAt) < new Date(value.endsAt), {
  message: 'Availability must end after it starts',
});
export const fixtureResultBodySchema = z.strictObject({
  homeScore: z.number().min(0).max(1000),
  awayScore: z.number().min(0).max(1000),
  expectedVersion: z.number().int().positive(),
});
export const relationshipSchema = z.strictObject({
  id: uuid,
  parentOrgId: uuid,
  parentOrgName: z.string(),
  childOrgId: uuid,
  childOrgName: z.string(),
  status: z.enum(['pending_child', 'pending_parent', 'active', 'ended', 'declined']),
  dataSharing: dataSharingSchema,
  dataSharingVersion: z.number().int().nonnegative(),
  parentAcceptedVersion: z.number().int().nonnegative(),
  childAcceptedVersion: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});
export const relationshipListSchema = z.strictObject({ relationships: z.array(relationshipSchema) });
export const federationProgramSchema = z.strictObject({
  id: uuid,
  programId: uuid,
  name: z.string(),
  rosterSubmissionDeadline: z.iso.datetime(),
  rosterFrozenAt: z.iso.datetime().nullable(),
  entryFeeCents: z.number().int().nonnegative(),
  feeDueOn: z.iso.date().nullable(),
  version: z.number().int().positive(),
});
export const federationEntrySchema = z.strictObject({
  id: uuid,
  federationProgramId: uuid,
  entrantOrgId: uuid,
  entrantOrgName: z.string(),
  entrantTeamSeasonId: uuid,
  teamName: z.string(),
  status: z.enum(['submitted', 'approved', 'declined', 'withdrawn']),
  rosterCount: z.number().int().nonnegative(),
  submittedAt: z.iso.datetime(),
  version: z.number().int().positive(),
});
export const federationEntryListSchema = z.strictObject({ entries: z.array(federationEntrySchema) });
export const federationRosterSchema = z.strictObject({
  teamName: z.string(),
  ageGroup: z.string().nullable(),
  players: z.array(z.strictObject({
    personId: uuid,
    name: z.string(),
    ageGroup: z.string().nullable(),
    cardNumber: z.string().nullable(),
    photoFileId: uuid.nullable(),
  })),
});
export const federationFixtureSchema = z.strictObject({
  id: uuid,
  eventId: uuid.nullable(),
  homeEntryId: uuid,
  homeTeamName: z.string(),
  homeOrgId: uuid,
  awayEntryId: uuid,
  awayTeamName: z.string(),
  awayOrgId: uuid,
  startsAt: z.iso.datetime(),
  location: z.string(),
  status: z.enum(['scheduled', 'final', 'canceled']),
  homeScore: z.number().nullable(),
  awayScore: z.number().nullable(),
  version: z.number().int().positive(),
});
export const federationFixtureListSchema = z.strictObject({ fixtures: z.array(federationFixtureSchema) });
export const federationStandingsSchema = z.strictObject({
  standings: z.array(z.strictObject({
    entryId: uuid,
    teamName: z.string(),
    organizationName: z.string(),
    played: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    draws: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    goalsFor: z.number(),
    goalsAgainst: z.number(),
    points: z.number().int().nonnegative(),
  })),
});
export const federationStaffComplianceSchema = z.strictObject({
  teamName: z.string(),
  staff: z.array(z.strictObject({ name: z.string(), role: z.string(), status: z.string() })),
});
