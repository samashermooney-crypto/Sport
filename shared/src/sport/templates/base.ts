import {
  sportProfileSchema,
  type ContestFormatConfig,
  type I18nText,
  type SportProfile,
  type StandingsConfig,
} from '../schema.js';

export type TemplateSeed = {
  key: string;
  name: string;
  es?: string;
  category: SportProfile['category'];
  formats: ContestFormatConfig[];
  positions?: string;
  rosterMax: number;
  rosterMin?: number;
  onField?: number;
  age: SportProfile['ageGroup'];
  venue: string;
  contest: string;
  coach?: string;
  duration?: number;
  practice?: number;
  buffer?: number;
  jersey?: 'required' | 'optional' | 'none';
  rubric?: string;
  uniforms?: string;
  officials?: string;
  discipline?: string;
  stats?: SportProfile['stats'];
  skillLevels?: SportProfile['skillLevels'];
  standings?: Partial<StandingsConfig> | null;
  minimumPlayRule?: SportProfile['minimumPlayRule'];
};

export const t = (en: string, es = en): I18nText => ({ en, es });
export const period = (
  label: string,
  count: number,
  minutes?: number,
): { label: I18nText; count: number; minutes?: number } => ({
  label: t(label),
  count,
  ...(minutes === undefined ? {} : { minutes }),
});
export const score = (
  label: string,
  count: number,
  allowTie: boolean,
  options: Partial<
    Extract<ContestFormatConfig, { format: 'head_to_head_score' }>
  > = {},
): ContestFormatConfig => ({
  format: 'head_to_head_score',
  periods: period(label, count),
  scoreLabel: t('Score', 'Marcador'),
  allowTie,
  scoreDirection: 'higher_wins',
  ...options,
});
export const sets = (
  bestOf: number,
  pointsPerSet: number,
  decidingSetPoints: number,
  options: Partial<
    Extract<ContestFormatConfig, { format: 'head_to_head_sets' }>
  > = {},
): ContestFormatConfig => ({
  format: 'head_to_head_sets',
  bestOf,
  pointsPerSet,
  decidingSetPoints,
  winBy: 2,
  scoringUnit: 'points',
  ...options,
});
export const bout = (
  methods: readonly (readonly [string, number])[],
  label = 'Period',
  count = 3,
): ContestFormatConfig => ({
  format: 'head_to_head_bout',
  methods: methods.map(([key, points]) => ({
    key,
    label: t(key.replaceAll('_', ' ')),
    teamPoints: points,
  })),
  periods: period(label, count),
});
export const timed = (
  events: readonly string[],
  options: Partial<
    Extract<ContestFormatConfig, { format: 'multi_timed' }>
  > = {},
): ContestFormatConfig => ({
  format: 'multi_timed',
  events: events.map((key) => ({ key, label: t(key.replaceAll('_', ' ')) })),
  lowerIsBetter: true,
  precision: 'hundredths',
  heats: false,
  lanes: 8,
  ...options,
});
export const measured = (
  events: readonly string[],
  lowerIsBetter: boolean,
  unit: Extract<ContestFormatConfig, { format: 'multi_measured' }>['unit'],
  options: Partial<
    Extract<ContestFormatConfig, { format: 'multi_measured' }>
  > = {},
): ContestFormatConfig => ({
  format: 'multi_measured',
  events: events.map((key) => ({ key, label: t(key.replaceAll('_', ' ')) })),
  lowerIsBetter,
  unit,
  ...options,
});
export const judged = (
  routines: readonly string[],
  judges: number,
  options: Partial<Extract<ContestFormatConfig, { format: 'judged' }>> = {},
): ContestFormatConfig => ({
  format: 'judged',
  apparatusOrRoutines: routines.map((key) => ({
    key,
    label: t(key.replaceAll('_', ' ')),
  })),
  panel: {
    judges,
    dropHighLow: judges >= 4,
    components: [
      { key: 'execution', label: t('Execution', 'Ejecución'), max: 10 },
    ],
    combine: 'average',
  },
  ...options,
});
export const placement = (
  events: readonly string[] = [],
): ContestFormatConfig => ({
  format: 'placement_only',
  events: events.map((key) => ({ key, label: t(key.replaceAll('_', ' ')) })),
});

const standardStandings: StandingsConfig = {
  basis: 'match',
  points: {
    win: 3,
    overtimeWin: 2,
    tie: 1,
    overtimeLoss: 1,
    loss: 0,
    forfeitWin: 3,
    forfeitLoss: 0,
    forfeitDeduction: 0,
  },
  rankBy: 'points',
  winPercentageTieValue: 0.5,
  forfeitScore: { winner: 3, loser: 0 },
  tiebreakers: [
    'head_to_head_points',
    'head_to_head_differential',
    'differential',
    'scored',
    'coin_toss_manual',
  ],
  include: { stages: ['regular'], crossDivision: false },
  columns: ['rank', 'team', 'played', 'wins', 'losses', 'ties', 'points'],
  publicVisibility: 'members',
};

function words(value: string | undefined): string[] {
  return (
    value
      ?.split('|')
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}
function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_|_$/g, '');
}

export function buildTemplate(seed: TemplateSeed): SportProfile {
  const positions = words(seed.positions).map((label) => ({
    key: slug(label),
    label: t(label),
  }));
  const rubricNames = words(seed.rubric).length
    ? words(seed.rubric)
    : seed.category === 'team'
      ? ['Technique', 'Decision making', 'Teamwork', 'Athleticism']
      : ['Technique', 'Consistency', 'Focus', 'Athleticism'];
  const uniformNames = words(seed.uniforms).length
    ? words(seed.uniforms)
    : seed.venue === 'pool'
      ? ['Cap', 'Suit']
      : seed.venue === 'mat'
        ? ['Uniform', 'Belt']
        : ['Jersey', 'Shorts', 'Socks'];
  const profile = {
    key: seed.key,
    name: t(seed.name, seed.es),
    category: seed.category,
    participantTerms: {
      athlete: t('Athlete', 'Atleta'),
      athletes: t('Athletes', 'Atletas'),
      team: t('Team', 'Equipo'),
      coach: t(
        seed.coach ?? 'Coach',
        seed.coach === 'Instructor' ? 'Instructor' : 'Entrenador',
      ),
      contest: t(
        seed.contest,
        seed.contest === 'Meet'
          ? 'Encuentro'
          : seed.contest === 'Match'
            ? 'Partido'
            : seed.contest === 'Dual'
              ? 'Duelo'
              : 'Juego',
      ),
      practice: t('Practice', 'Práctica'),
      venue: t(
        seed.venue.charAt(0).toUpperCase() + seed.venue.slice(1),
        seed.venue === 'field'
          ? 'Campo'
          : seed.venue === 'court'
            ? 'Cancha'
            : seed.venue === 'pool'
              ? 'Piscina'
              : seed.venue === 'mat'
                ? 'Tapiz'
                : seed.venue,
      ),
    },
    contestFormats: seed.formats,
    positions,
    maxPositionsPerAthlete: positions.length ? 2 : 0,
    roster: {
      defaultMax: seed.rosterMax,
      defaultMin: seed.rosterMin ?? 1,
      ...(seed.onField ? { onFieldCount: seed.onField } : {}),
      jerseyNumbers:
        seed.jersey ?? (seed.category === 'team' ? 'optional' : 'none'),
      ...(seed.jersey === 'none'
        ? {}
        : { jerseyRange: [0, 99] as [number, number] }),
    },
    stats: seed.stats ?? [],
    ...(seed.minimumPlayRule ? { minimumPlayRule: seed.minimumPlayRule } : {}),
    ageGroup: seed.age,
    defaultDurations: {
      contestMinutes: seed.duration ?? 60,
      practiceMinutes: seed.practice ?? 60,
      bufferMinutes: seed.buffer ?? 15,
    },
    spaceKinds: [seed.venue],
    officials: words(seed.officials).map((label) => ({
      key: slug(label),
      label: t(label),
      required: true,
    })),
    evaluationRubric: rubricNames.map((label) => ({
      key: slug(label),
      label: t(label),
      scaleMin: 1,
      scaleMax: 5,
      weight: 1,
    })),
    uniformItems: uniformNames.map((label) => ({
      key: slug(label),
      label: t(label),
      sizes: ['YS', 'YM', 'YL', 'AS', 'AM', 'AL', 'AXL'],
    })),
    ...(seed.standings === null || seed.category === 'individual'
      ? {}
      : {
          defaultStandings: { ...standardStandings, ...(seed.standings ?? {}) },
        }),
    ...(seed.skillLevels ? { skillLevels: seed.skillLevels } : {}),
    disciplineTypes: words(seed.discipline).map((label) => ({
      key: slug(label),
      label: t(label),
      defaultSuspensionGames:
        label.toLowerCase().includes('ejection') ||
        label.toLowerCase().includes('red')
          ? 1
          : 0,
    })),
  };
  return sportProfileSchema.parse(profile);
}
