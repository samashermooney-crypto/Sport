import { recurrenceSchema, timedRecurrenceSchema } from '@shared/recurrence';
import { z } from 'zod';

export const eventKindSchema = z.enum([
  'game',
  'practice',
  'meet',
  'match',
  'bout_session',
  'class_session',
  'evaluation_session',
  'tournament_game',
  'meeting',
  'volunteer_shift',
  'other',
]);
export const eventStatusSchema = z.enum([
  'scheduled',
  'postponed',
  'canceled',
  'completed',
]);

export const participantInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('team'),
    id: z.uuid(),
    side: z.enum(['home', 'away', 'none']).default('none'),
  }),
  z.strictObject({
    type: z.literal('external_team'),
    id: z.uuid(),
    side: z.enum(['home', 'away', 'none']).default('none'),
  }),
  z.strictObject({
    type: z.literal('person'),
    id: z.uuid(),
    side: z.enum(['home', 'away', 'none']).default('none'),
  }),
  z.strictObject({
    type: z.literal('division'),
    id: z.uuid(),
    side: z.enum(['home', 'away', 'none']).default('none'),
  }),
]);

export const eventCreateSchema = z.strictObject({
  kind: eventKindSchema,
  title: z.string().trim().min(1).max(200),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  timezone: z.string().min(1).max(80).optional(),
  programId: z.uuid().nullable().optional(),
  divisionId: z.uuid().nullable().optional(),
  spaceId: z.uuid().nullable().optional(),
  locationText: z.string().trim().max(500).nullable().optional(),
  notesHtml: z.string().max(4000).nullable().optional(),
  arrivalMinutesBefore: z.number().int().min(0).max(1440).default(0),
  participants: z.array(participantInputSchema).max(100).default([]),
  published: z.boolean().default(false),
});

export const eventUpdateSchema = eventCreateSchema.partial().extend({
  expectedVersion: z.number().int().positive(),
  overrideReason: z.string().trim().min(10).max(500).optional(),
});

export const eventCreateWithOverrideSchema = eventCreateSchema.extend({
  overrideReason: z.string().trim().min(10).max(500).optional(),
});

export const eventSeriesCreateSchema = z.strictObject({
  recurrence: recurrenceSchema,
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),
  durationMinutes: z.number().int().min(5).max(720),
  timezone: z
    .string()
    .min(1)
    .max(80)
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, 'Expected an IANA timezone'),
  template: eventCreateSchema.omit({
    startsAt: true,
    endsAt: true,
    timezone: true,
  }),
  overrideReason: z.string().trim().min(10).max(500).optional(),
});

export const seriesEditSchema = z.strictObject({
  scope: z.enum(['this', 'following', 'all']),
  occurrenceStartsAt: z.iso.datetime({ offset: true }),
  startsAt: z.iso.datetime({ offset: true }).optional(),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  expectedVersion: z.number().int().positive(),
  recurrence: timedRecurrenceSchema.optional(),
  template: eventCreateSchema
    .omit({ startsAt: true, endsAt: true, timezone: true })
    .partial()
    .optional(),
  overrideReason: z.string().trim().min(10).max(500).optional(),
});

export const eventResponseSchema = z.strictObject({
  id: z.uuid(),
  orgId: z.uuid(),
  title: z.string(),
  kind: eventKindSchema,
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  timezone: z.string(),
  status: eventStatusSchema,
  statusReason: z.string().nullable(),
  published: z.boolean(),
  programId: z.uuid().nullable(),
  divisionId: z.uuid().nullable(),
  spaceId: z.uuid().nullable(),
  locationText: z.string().nullable(),
  notesHtml: z.string().nullable(),
  arrivalMinutesBefore: z.number().int(),
  version: z.number().int().positive(),
});

export const eventListSchema = z.strictObject({
  items: z.array(eventResponseSchema),
});
export const eventIdResponseSchema = z.strictObject({ id: z.uuid() });
export const conflictReportSchema = z.strictObject({
  conflicts: z.array(
    z.strictObject({
      kind: z.enum([
        'space',
        'blackout',
        'availability',
        'team',
        'coach',
        'official',
      ]),
      eventId: z.uuid().nullable(),
      message: z.string(),
      overridable: z.boolean(),
    }),
  ),
});

export const closureCreateSchema = z.strictObject({
  scopeType: z.enum(['facility', 'space', 'org']),
  scopeId: z.uuid().nullable().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  reason: z.enum(['weather', 'maintenance', 'permit', 'other']),
  message: z.string().trim().max(500).nullable().optional(),
  previewOnly: z.boolean().default(false),
});

export const allocationCreateSchema = z.strictObject({
  spaceId: z.uuid(),
  teamSeasonId: z.uuid().nullable().optional(),
  divisionId: z.uuid().nullable().optional(),
  recurrence: recurrenceSchema,
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),
  timezone: z.string().min(1).max(80),
  purpose: z.enum(['practice', 'games', 'clinic', 'other']),
});

export const spaceAvailabilityCreateSchema = z.strictObject({
  spaceId: z.uuid(),
  recurrence: recurrenceSchema,
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),
  timezone: z.string().min(1).max(80),
  source: z.enum(['owned', 'permit']),
  permitReference: z.string().trim().max(200).nullable().optional(),
  costPerHourCents: z.number().int().nonnegative().nullable().optional(),
});

export const spaceBlackoutCreateSchema = z.strictObject({
  scopeType: z.enum(['facility', 'space']),
  scopeId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500),
});

export const scheduleSettingsSchema = z.strictObject({
  programId: z.uuid(),
  coachSlotPickerEnabled: z.boolean(),
  slotApprovalRequired: z.boolean(),
  expectedVersion: z.number().int().positive().optional(),
});

export const blackoutRequestSchema = z.strictObject({
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  reason: z.string().trim().min(1).max(500),
});

export const blackoutDecisionSchema = z.strictObject({
  approve: z.boolean(),
  expectedVersion: z.number().int().positive(),
});

export const bulkShiftSchema = z.strictObject({
  fromDate: z.iso.date(),
  toDate: z.iso.date(),
  timezone: z.string().min(1).max(80),
  overrideReason: z.string().trim().min(10).max(500).optional(),
});

export const csvImportSchema = z.union([
  z.strictObject({
    csv: z
      .string()
      .min(1)
      .max(20 * 1024 * 1024),
  }),
  z.strictObject({
    fileName: z.string().trim().min(1).max(255),
    contentBase64: z
      .string()
      .min(1)
      .max(28 * 1024 * 1024),
  }),
]);

export const rescheduleRequestSchema = z.strictObject({
  reason: z.string().trim().min(10).max(1000),
  proposedSlots: z
    .array(
      z.strictObject({
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }),
        spaceId: z.uuid().nullable().optional(),
      }),
    )
    .min(1)
    .max(10),
});

export const generatorConstraintsSchema = z.strictObject({
  seed: z.number().int().min(0).max(2_147_483_647),
  seasonStartsOn: z.iso.date(),
  seasonEndsOn: z.iso.date(),
  divisions: z
    .array(
      z.strictObject({
        divisionId: z.uuid(),
        gamesPerTeam: z.number().int().min(1).max(100).optional(),
        roundRobin: z.enum(['once', 'twice']).optional(),
        allowedWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
        timeWindows: z
          .array(z.strictObject({ start: z.string(), end: z.string() }))
          .min(1),
        preferredStartMinutes: z.number().int().min(0).max(1439).optional(),
        ageOrder: z.number().int().optional(),
      }),
    )
    .min(1)
    .max(100),
  maxGamesPerTeamPerDay: z.number().int().min(1).max(4).default(1),
  maxGamesPerTeamPerWeek: z.number().int().min(1).max(14).optional(),
  minRestHours: z.number().min(0).max(240).default(18),
  timeBudgetSeconds: z.number().int().min(1).max(120).default(45),
});

export const generationRunResponseSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum([
    'queued',
    'running',
    'succeeded',
    'failed',
    'applied',
    'discarded',
  ]),
  progress: z.number().int().min(0).max(100),
  progressMessage: z.string().nullable(),
  result: z.unknown().nullable(),
  errorCode: z.string().nullable(),
  version: z.number().int().positive(),
});

export const feedCreatedSchema = z.strictObject({
  id: z.uuid(),
  url: z.string(),
});

export const eventSeriesSchema = eventSeriesCreateSchema;
export type EventCreateInput = z.infer<typeof eventCreateSchema>;
export type EventCreateWithOverrideInput = z.infer<
  typeof eventCreateWithOverrideSchema
>;
export type EventUpdateInput = z.infer<typeof eventUpdateSchema>;
export type EventSeriesCreateInput = z.infer<typeof eventSeriesCreateSchema>;
export type SeriesEditInput = z.infer<typeof seriesEditSchema>;
export type GeneratorConstraints = z.infer<typeof generatorConstraintsSchema>;
export type SpaceAvailabilityCreateInput = z.infer<
  typeof spaceAvailabilityCreateSchema
>;
export type SpaceBlackoutCreateInput = z.infer<
  typeof spaceBlackoutCreateSchema
>;
export type BlackoutRequestInput = z.infer<typeof blackoutRequestSchema>;
