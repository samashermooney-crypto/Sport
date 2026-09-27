export type EvaluationCriterion = {
  key: string;
  weight: number;
  scaleMin: number;
  scaleMax: number;
  positionSpecific?: boolean;
  positionKeys?: readonly string[];
};
export type EvaluationAthlete = {
  id: string;
  name: string;
  group: string;
  positions: readonly string[];
};
export type EvaluationScore = {
  athleteId: string;
  evaluatorId: string;
  criterionKey: string;
  score: number;
};
export type EvaluationInput = {
  criteria: readonly EvaluationCriterion[];
  athletes: readonly EvaluationAthlete[];
  scores: readonly EvaluationScore[];
  normalization: 'none' | 'z_score_per_evaluator';
};
export type EvaluationResult = {
  athleteId: string;
  group: string;
  criterionValues: Record<string, number>;
  composite: number | null;
  rankInGroup: number | null;
  evaluatorCount: number;
  needsSecondEvaluator: boolean;
  missingCriteria: string[];
};

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function sd(values: readonly number[]): number {
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length,
  );
}
function applicable(
  criterion: EvaluationCriterion,
  athlete: EvaluationAthlete,
): boolean {
  return (
    !criterion.positionSpecific ||
    !criterion.positionKeys?.length ||
    criterion.positionKeys.some((position) =>
      athlete.positions.includes(position),
    )
  );
}

export function scoreEvaluations(input: EvaluationInput): EvaluationResult[] {
  if (
    new Set(input.athletes.map((athlete) => athlete.id)).size !==
      input.athletes.length ||
    new Set(input.criteria.map((criterion) => criterion.key)).size !==
      input.criteria.length
  )
    throw new RangeError('Duplicate athlete or criterion');
  const byAthlete = new Map(
    input.athletes.map((athlete) => [athlete.id, athlete]),
  );
  const byCriterion = new Map(
    input.criteria.map((criterion) => [criterion.key, criterion]),
  );
  const scoreKeys = new Set<string>();
  for (const score of input.scores) {
    const criterion = byCriterion.get(score.criterionKey);
    const athlete = byAthlete.get(score.athleteId);
    if (!criterion || !athlete || !applicable(criterion, athlete))
      throw new RangeError(
        'Score references an unknown or inapplicable athlete criterion',
      );
    if (
      !Number.isFinite(score.score) ||
      score.score < criterion.scaleMin ||
      score.score > criterion.scaleMax
    )
      throw new RangeError('Score outside rubric scale');
    const key = `${score.athleteId}:${score.evaluatorId}:${score.criterionKey}`;
    if (scoreKeys.has(key)) throw new RangeError('Duplicate evaluator score');
    scoreKeys.add(key);
  }
  const normalized = new Map<EvaluationScore, number>();
  for (const criterion of input.criteria) {
    const scores = input.scores.filter(
      (item) => item.criterionKey === criterion.key,
    );
    if (!scores.length) continue;
    const global = scores.map((item) => item.score);
    const globalMean = mean(global);
    const globalSd = sd(global);
    const evaluators = new Set(scores.map((item) => item.evaluatorId));
    for (const evaluatorId of evaluators) {
      const own = scores.filter((item) => item.evaluatorId === evaluatorId);
      const ownValues = own.map((item) => item.score);
      const ownMean = mean(ownValues);
      const ownSd = sd(ownValues);
      for (const item of own) {
        const value =
          input.normalization === 'none'
            ? item.score
            : own.length < 8 || ownSd === 0
              ? globalMean + item.score - ownMean
              : globalMean + ((item.score - ownMean) / ownSd) * globalSd;
        normalized.set(
          item,
          Math.max(criterion.scaleMin, Math.min(criterion.scaleMax, value)),
        );
      }
    }
  }
  const results = input.athletes.map((athlete): EvaluationResult => {
    const criterionValues: Record<string, number> = {};
    const missingCriteria: string[] = [];
    const eligible = input.criteria.filter((criterion) =>
      applicable(criterion, athlete),
    );
    let weighted = 0;
    let totalWeight = 0;
    for (const criterion of eligible) {
      if (
        !Number.isFinite(criterion.weight) ||
        criterion.weight <= 0 ||
        criterion.scaleMax <= criterion.scaleMin
      )
        throw new RangeError('Invalid rubric criterion');
      const scores = input.scores.filter(
        (item) =>
          item.athleteId === athlete.id && item.criterionKey === criterion.key,
      );
      if (!scores.length) {
        missingCriteria.push(criterion.key);
        continue;
      }
      const value = mean(
        scores.map((item) => normalized.get(item) ?? item.score),
      );
      criterionValues[criterion.key] = value;
      weighted += value * criterion.weight;
      totalWeight += criterion.weight;
    }
    const evaluatorCount = new Set(
      input.scores
        .filter((item) => item.athleteId === athlete.id)
        .map((item) => item.evaluatorId),
    ).size;
    return {
      athleteId: athlete.id,
      group: athlete.group,
      criterionValues,
      composite:
        missingCriteria.length || !totalWeight ? null : weighted / totalWeight,
      rankInGroup: null,
      evaluatorCount,
      needsSecondEvaluator: evaluatorCount < 2,
      missingCriteria,
    };
  });
  const nameById = new Map(
    input.athletes.map((athlete) => [athlete.id, athlete.name]),
  );
  const groups = new Set(results.map((result) => result.group));
  for (const group of groups) {
    const ranked = results
      .filter((result) => result.group === group && result.composite !== null)
      .sort(
        (a, b) =>
          (b.composite ?? 0) - (a.composite ?? 0) ||
          b.evaluatorCount - a.evaluatorCount ||
          (nameById.get(a.athleteId) ?? '').localeCompare(
            nameById.get(b.athleteId) ?? '',
          ) ||
          a.athleteId.localeCompare(b.athleteId),
      );
    ranked.forEach((result, index) => {
      result.rankInGroup = index + 1;
    });
  }
  return results;
}
