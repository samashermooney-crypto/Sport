import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

import { type AgeGroupConfig } from './age.js';

const key = z.string().regex(/^[a-z0-9][a-z0-9_]*$/);
const nonnegative = z.number().nonnegative();
const positiveInt = z.number().int().positive();
const monthDay = z
  .string()
  .regex(/^\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      Temporal.PlainDate.from(
        {
          year: 2000,
          month: Number(value.slice(0, 2)),
          day: Number(value.slice(3)),
        },
        { overflow: 'reject' },
      );
      return true;
    } catch {
      return false;
    }
  }, 'Expected a valid MM-DD');
export const i18nTextSchema = z.object({
  en: z.string().min(1),
  es: z.string().min(1),
});
export type I18nText = z.infer<typeof i18nTextSchema>;

const periodSchema = z.object({
  label: i18nTextSchema,
  count: positiveInt,
  minutes: positiveInt.optional(),
});
const eventSchema = z.object({
  key,
  label: i18nTextSchema,
  distance: nonnegative.optional(),
  unit: z.string().min(1).optional(),
  relay: z.boolean().optional(),
  ageGenderSplit: z.boolean().optional(),
});
const placePoints = z.array(nonnegative).optional();

export const contestFormatSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('head_to_head_score'),
    periods: periodSchema,
    scoreLabel: i18nTextSchema,
    allowTie: z.boolean(),
    overtime: z
      .object({ label: i18nTextSchema, maxPeriods: positiveInt.optional() })
      .optional(),
    shootout: z.boolean().optional(),
    scoreDirection: z.literal('higher_wins'),
    mercyRule: z
      .object({ margin: positiveInt, afterPeriod: positiveInt })
      .optional(),
  }),
  z.object({
    format: z.literal('head_to_head_sets'),
    bestOf: positiveInt.refine(
      (value) => value % 2 === 1,
      'bestOf must be odd',
    ),
    pointsPerSet: positiveInt,
    decidingSetPoints: positiveInt,
    winBy: positiveInt,
    cap: positiveInt.optional(),
    scoringUnit: z.enum(['points', 'games']),
    tiebreakAt: positiveInt.optional(),
  }),
  z.object({
    format: z.literal('head_to_head_bout'),
    methods: z
      .array(
        z.object({
          key,
          label: i18nTextSchema,
          teamPoints: nonnegative.optional(),
        }),
      )
      .min(1),
    periods: periodSchema,
    weightClasses: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    format: z.literal('multi_timed'),
    events: z.array(eventSchema).min(1),
    lowerIsBetter: z.literal(true),
    precision: z.enum(['hundredths', 'tenths', 'seconds']),
    heats: z.boolean(),
    lanes: positiveInt,
    placePoints,
    relayPlacePoints: placePoints,
    teamScoring: z
      .object({ method: z.literal('sum_of_places_top_n'), count: positiveInt })
      .optional(),
  }),
  z.object({
    format: z.literal('multi_measured'),
    events: z.array(eventSchema).min(1),
    lowerIsBetter: z.boolean(),
    unit: z.enum(['m', 'cm', 'ft_in', 'strokes', 'points', 'pins']),
    attempts: positiveInt.optional(),
    placePoints,
    teamScoring: z
      .object({ method: z.literal('best_n_of_m'), count: positiveInt })
      .optional(),
  }),
  z.object({
    format: z.literal('judged'),
    apparatusOrRoutines: z.array(eventSchema).min(1),
    panel: z.object({
      judges: positiveInt,
      dropHighLow: z.boolean(),
      components: z
        .array(
          z.object({ key, label: i18nTextSchema, max: nonnegative.optional() }),
        )
        .min(1),
      combine: z.enum(['sum', 'average']),
    }),
    placePoints,
  }),
  z.object({
    format: z.literal('placement_only'),
    events: z.array(eventSchema).optional(),
    placePoints,
  }),
]);
export type ContestFormatConfig = z.infer<typeof contestFormatSchema>;

export const ageGroupSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('age_on_date'),
    monthDay,
    yearBasis: z.enum(['season_start', 'season_end', 'calendar_year_of_start']),
  }),
  z.object({
    method: z.literal('birth_year'),
    label: z.enum(['U{n}', '{n}U', '{year}']),
    seasonYearBasis: z.enum(['season_start', 'season_end']),
  }),
  z.object({ method: z.literal('school_grade'), schoolYearCutoff: monthDay }),
  z.object({ method: z.literal('none') }),
]);
const statSchema = z.object({
  key,
  label: i18nTextSchema,
  abbreviation: z.string().min(1),
  level: z.enum(['athlete', 'team']),
  valueType: z.enum(['integer', 'decimal', 'time_ms', 'percentage']),
  aggregate: z.enum(['sum', 'max', 'min', 'average']),
  derived: z
    .object({
      formula: z.enum(['ratio', 'percentage']),
      numerator: key,
      denominator: key,
    })
    .optional(),
  public: z.boolean(),
});
export type StatDefinition = z.infer<typeof statSchema>;

export const tiebreakerSchema = z.enum([
  'head_to_head_points',
  'head_to_head_differential',
  'wins',
  'fewest_losses',
  'differential',
  'scored',
  'fewest_allowed',
  'set_ratio',
  'point_ratio',
  'sets_won',
  'fewest_forfeits',
  'fewest_discipline_points',
  'net_run_rate',
  'coin_toss_manual',
]);
export type Tiebreaker = z.infer<typeof tiebreakerSchema>;
export const contestStageSchema = z.enum([
  'regular',
  'pool',
  'playoff',
  'tournament',
  'friendly',
]);
export type ContestStage = z.infer<typeof contestStageSchema>;
export const standingsColumnSchema = z.enum([
  'rank',
  'team',
  'played',
  'wins',
  'losses',
  'ties',
  'overtime_wins',
  'overtime_losses',
  'forfeits',
  'points',
  'win_percentage',
  'scored',
  'allowed',
  'differential',
  'sets_won',
  'sets_lost',
  'set_ratio',
  'point_ratio',
  'net_run_rate',
]);

export const standingsConfigSchema = z.object({
  basis: z.enum(['match', 'set', 'points_table']),
  points: z.object({
    win: nonnegative,
    overtimeWin: nonnegative,
    tie: nonnegative,
    overtimeLoss: nonnegative,
    loss: nonnegative,
    forfeitWin: nonnegative,
    forfeitLoss: nonnegative,
    forfeitDeduction: nonnegative,
  }),
  rankBy: z.enum(['points', 'win_percentage', 'wins']),
  winPercentageTieValue: z.union([z.literal(0.5), z.literal(0)]),
  forfeitScore: z.object({ winner: nonnegative, loser: nonnegative }),
  maxGoalDifferential: nonnegative.optional(),
  bonusPoints: z
    .object({
      triesThreshold: positiveInt,
      losingMargin: nonnegative,
      bonusPoint: nonnegative,
    })
    .optional(),
  tiebreakers: z.array(tiebreakerSchema).min(1).max(8),
  include: z.object({
    stages: z.array(contestStageSchema).min(1),
    crossDivision: z.boolean(),
  }),
  columns: z.array(standingsColumnSchema).min(1),
  publicVisibility: z.enum(['public', 'members', 'hidden']),
});
export type StandingsConfig = z.infer<typeof standingsConfigSchema>;

export const rubricCriterionSchema = z
  .object({
    key,
    label: i18nTextSchema,
    scaleMin: z.number(),
    scaleMax: z.number(),
    weight: z.number().positive(),
    positionSpecific: z.boolean().optional(),
    positionKeys: z.array(key).optional(),
  })
  .refine(
    (criterion) => criterion.scaleMax > criterion.scaleMin,
    'scaleMax must exceed scaleMin',
  );
export type RubricCriterion = z.infer<typeof rubricCriterionSchema>;

export const sportProfileSchema = z
  .object({
    key,
    name: i18nTextSchema,
    category: z.enum(['team', 'individual', 'hybrid']),
    participantTerms: z.object({
      athlete: i18nTextSchema,
      athletes: i18nTextSchema,
      team: i18nTextSchema,
      coach: i18nTextSchema,
      contest: i18nTextSchema,
      practice: i18nTextSchema,
      venue: i18nTextSchema,
    }),
    contestFormats: z.array(contestFormatSchema).min(1),
    positions: z.array(
      z.object({
        key,
        label: i18nTextSchema,
        group: z.string().min(1).optional(),
      }),
    ),
    maxPositionsPerAthlete: z.number().int().nonnegative(),
    roster: z
      .object({
        defaultMax: positiveInt,
        defaultMin: z.number().int().nonnegative(),
        onFieldCount: positiveInt.optional(),
        jerseyNumbers: z.enum(['required', 'optional', 'none']),
        jerseyRange: z
          .tuple([
            z.number().int().nonnegative(),
            z.number().int().nonnegative(),
          ])
          .optional(),
      })
      .refine(
        (roster) => roster.defaultMin <= roster.defaultMax,
        'Roster minimum exceeds maximum',
      ),
    stats: z.array(statSchema),
    minimumPlayRule: z
      .object({
        unit: z.enum(['periods', 'minutes', 'innings']),
        defaultRequirement: nonnegative,
      })
      .optional(),
    ageGroup: ageGroupSchema,
    defaultDurations: z.object({
      contestMinutes: positiveInt,
      practiceMinutes: positiveInt,
      bufferMinutes: z.number().int().nonnegative(),
    }),
    spaceKinds: z.array(key).min(1),
    officials: z.array(
      z.object({ key, label: i18nTextSchema, required: z.boolean() }),
    ),
    evaluationRubric: z.array(rubricCriterionSchema),
    uniformItems: z.array(
      z.object({
        key,
        label: i18nTextSchema,
        sizes: z.array(z.string().min(1)),
      }),
    ),
    defaultStandings: standingsConfigSchema.optional(),
    skillLevels: z
      .array(
        z.object({ name: i18nTextSchema, skills: z.array(i18nTextSchema) }),
      )
      .optional(),
    disciplineTypes: z.array(
      z.object({
        key,
        label: i18nTextSchema,
        defaultSuspensionGames: z.number().int().nonnegative(),
      }),
    ),
  })
  .superRefine((profile, ctx) => {
    const unique = (values: readonly string[], path: string): void => {
      if (new Set(values).size !== values.length)
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate ${path} key`,
          path: [path],
        });
    };
    unique(
      profile.positions.map((item) => item.key),
      'positions',
    );
    unique(
      profile.stats.map((item) => item.key),
      'stats',
    );
    unique(
      profile.officials.map((item) => item.key),
      'officials',
    );
    unique(
      profile.evaluationRubric.map((item) => item.key),
      'evaluationRubric',
    );
    unique(
      profile.uniformItems.map((item) => item.key),
      'uniformItems',
    );
    unique(
      profile.disciplineTypes.map((item) => item.key),
      'disciplineTypes',
    );
    if (
      profile.roster.jerseyRange &&
      profile.roster.jerseyRange[0] > profile.roster.jerseyRange[1]
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Jersey range is reversed',
        path: ['roster', 'jerseyRange'],
      });
  });
export type SportProfile = z.infer<typeof sportProfileSchema>;
export type { AgeGroupConfig };
