import { type StatDefinition } from './schema.js';

export type StatEntry = {
  subjectId: string;
  values: Readonly<Record<string, number>>;
};
export type StatSummary = { subjectId: string; values: Record<string, number> };

export function aggregateStats(
  definitions: readonly StatDefinition[],
  entries: readonly StatEntry[],
): StatSummary[] {
  const keys = new Set(definitions.map((definition) => definition.key));
  if (keys.size !== definitions.length)
    throw new RangeError('Duplicate stat definition');
  const groups = new Map<string, StatEntry[]>();
  for (const entry of entries)
    groups.set(entry.subjectId, [
      ...(groups.get(entry.subjectId) ?? []),
      entry,
    ]);
  return [...groups].map(([subjectId, group]) => {
    const values: Record<string, number> = {};
    for (const definition of definitions.filter((item) => !item.derived)) {
      const samples = group.flatMap((entry) =>
        entry.values[definition.key] === undefined
          ? []
          : [entry.values[definition.key] ?? 0],
      );
      if (
        samples.some(
          (sample) =>
            !Number.isFinite(sample) ||
            (definition.valueType === 'integer' && !Number.isInteger(sample)) ||
            (definition.valueType === 'time_ms' &&
              (!Number.isSafeInteger(sample) || sample < 0)),
        )
      )
        throw new RangeError(`Invalid value for ${definition.key}`);
      values[definition.key] = !samples.length
        ? 0
        : definition.aggregate === 'sum'
          ? samples.reduce((a, b) => a + b, 0)
          : definition.aggregate === 'max'
            ? Math.max(...samples)
            : definition.aggregate === 'min'
              ? Math.min(...samples)
              : samples.reduce((a, b) => a + b, 0) / samples.length;
    }
    for (const definition of definitions.filter((item) => item.derived)) {
      const numerator = definition.derived
        ? values[definition.derived.numerator]
        : undefined;
      const denominator = definition.derived
        ? values[definition.derived.denominator]
        : undefined;
      if (numerator === undefined || denominator === undefined)
        throw new RangeError(`Unknown stat reference for ${definition.key}`);
      values[definition.key] =
        denominator === 0
          ? 0
          : definition.derived?.formula === 'percentage'
            ? (numerator / denominator) * 100
            : numerator / denominator;
    }
    return { subjectId, values };
  });
}

export function statLeaders(
  definition: StatDefinition,
  summaries: readonly StatSummary[],
  options: { youth: boolean; viewerCanSeePrivate: boolean; limit?: number },
): { subjectId: string; value: number; rank: number }[] {
  if (options.youth && !definition.public && !options.viewerCanSeePrivate)
    return [];
  const limit = options.limit ?? summaries.length;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError('Invalid leaderboard limit');
  const sorted = summaries
    .map((summary) => ({
      subjectId: summary.subjectId,
      value: summary.values[definition.key] ?? 0,
    }))
    .sort((a, b) =>
      definition.aggregate === 'min'
        ? a.value - b.value || a.subjectId.localeCompare(b.subjectId)
        : b.value - a.value || a.subjectId.localeCompare(b.subjectId),
    );
  return sorted
    .slice(0, limit)
    .map((entry, index) => ({
      ...entry,
      rank:
        sorted.findIndex((other) => other.value === entry.value) + 1 ||
        index + 1,
    }));
}
