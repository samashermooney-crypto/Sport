import { REPORT_DATASETS, tierAllowed } from '@shared/reports/datasets';
import type { Dataset, DatasetColumn } from '@shared/reports/datasets';
import type { ReportDefinition, ReportFilter } from '@shared/schemas/reports';
import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';

import type { OrgTransaction } from '../../db/withOrg';

const receivablesAging: DatasetColumn = {
  key: 'aging_bucket',
  label: 'Receivables age',
  type: 'enum',
  tier: 'internal',
  source: `CASE
    WHEN t.balance_cents <= 0 THEN 'Settled'
    WHEN t.due_on IS NULL THEN 'No due date'
    WHEN t.due_on >= CURRENT_DATE THEN 'Not due'
    WHEN t.due_on >= CURRENT_DATE - 30 THEN '1–30 days overdue'
    WHEN t.due_on >= CURRENT_DATE - 60 THEN '31–60 days overdue'
    WHEN t.due_on >= CURRENT_DATE - 90 THEN '61–90 days overdue'
    ELSE '90+ days overdue'
  END`,
};

const payoutDataset: Dataset = {
  key: 'payouts',
  label: 'Payouts',
  description: 'Settlement payouts and arrival status',
  table: 'payouts',
  requiredTables: ['payouts'],
  joins: [],
  roles: ['owner', 'admin', 'finance', 'reporter'],
  columns: [
    {
      key: 'id',
      label: 'Payout ID',
      type: 'text',
      tier: 'internal',
      source: 't.id',
    },
    {
      key: 'status',
      label: 'Status',
      type: 'enum',
      tier: 'internal',
      source: 't.status',
    },
    {
      key: 'amount_cents',
      label: 'Amount',
      type: 'money',
      tier: 'sensitive',
      source: 't.amount_cents',
    },
    {
      key: 'arrival_date',
      label: 'Arrival date',
      type: 'date',
      tier: 'internal',
      source: 't.arrival_date',
    },
  ],
};

const evaluationResultsDataset: Dataset = {
  key: 'evaluation_results',
  label: 'Evaluation results',
  description: 'Scored participants and group rankings for tryout events',
  table: 'evaluation_results',
  requiredTables: [
    'evaluation_results',
    'evaluation_events',
    'evaluation_participants',
    'evaluation_groups',
    'people',
    'programs',
  ],
  joins: [
    {
      alias: 'e',
      table: 'evaluation_events',
      on: 'e.id = t.evaluation_event_id AND e.org_id = t.org_id',
    },
    {
      alias: 'p',
      table: 'evaluation_participants',
      on: 'p.id = t.evaluation_participant_id AND p.org_id = t.org_id',
    },
    {
      alias: 'g',
      table: 'evaluation_groups',
      on: 'g.id = p.evaluation_group_id AND g.org_id = t.org_id',
    },
    {
      alias: 'person',
      table: 'people',
      on: 'person.id = p.person_id AND person.org_id = t.org_id',
    },
    {
      alias: 'program',
      table: 'programs',
      on: 'program.id = e.target_program_id AND program.org_id = t.org_id',
    },
  ],
  roles: ['owner', 'admin', 'director', 'registrar', 'scheduler'],
  columns: [
    {
      key: 'event_name',
      label: 'Evaluation event',
      type: 'text',
      tier: 'internal',
      source: 'e.name',
    },
    {
      key: 'program_name',
      label: 'Target program',
      type: 'text',
      tier: 'internal',
      source: 'program.name',
    },
    {
      key: 'group_name',
      label: 'Evaluation group',
      type: 'text',
      tier: 'internal',
      source: 'g.name',
    },
    {
      key: 'participant_name',
      label: 'Participant',
      type: 'text',
      tier: 'sensitive',
      source: "person.first_name || ' ' || person.last_name",
    },
    {
      key: 'rank_in_group',
      label: 'Group rank',
      type: 'number',
      tier: 'sensitive',
      source: 't.rank_in_group',
    },
    {
      key: 'composite_score',
      label: 'Composite score',
      type: 'number',
      tier: 'sensitive',
      source: 't.composite',
    },
    {
      key: 'evaluator_count',
      label: 'Evaluator count',
      type: 'number',
      tier: 'internal',
      source: 't.evaluator_count',
    },
    {
      key: 'missing_criteria_count',
      label: 'Missing criteria count',
      type: 'number',
      tier: 'internal',
      source: 'cardinality(t.missing_criteria)',
    },
    {
      key: 'computed_at',
      label: 'Computed at',
      type: 'datetime',
      tier: 'internal',
      source: 't.computed_at',
    },
  ],
};

export const reportDatasetCatalog: readonly Dataset[] = [
  ...REPORT_DATASETS.map((dataset) =>
    dataset.key === 'invoices'
      ? { ...dataset, columns: [...dataset.columns, receivablesAging] }
      : dataset,
  ),
  payoutDataset,
  evaluationResultsDataset,
];
const datasetsByKey = new Map(
  reportDatasetCatalog.map((dataset) => [dataset.key, dataset]),
);

export class ReportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ReportResult {
  columns: { key: string; label: string; type: string }[];
  rows: unknown[][];
  truncated: boolean;
}

export function datasetForActor(
  key: string,
  roles: readonly string[],
): Dataset {
  const dataset = datasetsByKey.get(key);
  if (!dataset) throw new ReportError(404, 'NOT_FOUND', 'Unknown dataset');
  if (!dataset.roles.some((role) => roles.includes(role)))
    throw new ReportError(404, 'NOT_FOUND', 'Unknown dataset');
  return dataset;
}

/** Every column the actor may see, whether selected or used only to filter. */
export function columnsForActor(
  dataset: Dataset,
  roles: readonly string[],
  options: { registrarMedicalAccess?: boolean } = {},
): DatasetColumn[] {
  return dataset.columns.filter((column) =>
    tierAllowed(roles, column.tier, options),
  );
}

export function resolveColumns(
  dataset: Dataset,
  visible: DatasetColumn[],
  definition: ReportDefinition,
): DatasetColumn[] {
  const visibleKeys = new Set(visible.map((column) => column.key));
  const keys = definition.columns.length
    ? definition.columns
    : visible.map((column) => column.key);
  for (const key of keys) {
    if (!visibleKeys.has(key)) {
      const exists = dataset.columns.some((column) => column.key === key);
      throw new ReportError(
        403,
        'FORBIDDEN',
        exists
          ? `Column "${key}" is above your data tier`
          : `Unknown column "${key}"`,
      );
    }
  }
  return keys.map((key) => {
    const column = visible.find((candidate) => candidate.key === key);
    if (!column) {
      throw new ReportError(400, 'VALIDATION_ERROR', `Unknown column "${key}"`);
    }
    return column;
  });
}

function filterValueMatches(
  type: DatasetColumn['type'],
  value: unknown,
): boolean {
  switch (type) {
    case 'number':
    case 'money':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
      {
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return (
          !Number.isNaN(parsed.valueOf()) &&
          parsed.toISOString().slice(0, 10) === value
        );
      }
    case 'datetime':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'enum':
    case 'text':
      return typeof value === 'string';
  }
}

function validateFilter(filter: ReportFilter, column: DatasetColumn): void {
  if (filter.op === 'is_null' || filter.op === 'not_null') {
    if (filter.value !== undefined)
      throw new ReportError(
        400,
        'VALIDATION_ERROR',
        'Null checks take no value',
      );
    return;
  }
  if (filter.value === undefined)
    throw new ReportError(400, 'VALIDATION_ERROR', 'Filter value is required');
  if (
    Array.isArray(filter.value) &&
    filter.op !== 'in' &&
    filter.op !== 'between'
  )
    throw new ReportError(
      400,
      'VALIDATION_ERROR',
      'Only in and between filters accept multiple values',
    );
  if (
    ['lt', 'lte', 'gt', 'gte', 'between'].includes(filter.op) &&
    !['number', 'money', 'date', 'datetime'].includes(column.type)
  )
    throw new ReportError(
      400,
      'VALIDATION_ERROR',
      'Range filters require a number or date column',
    );
  if (
    (filter.op === 'contains' || filter.op === 'starts_with') &&
    column.type !== 'text' &&
    column.type !== 'enum'
  )
    throw new ReportError(
      400,
      'VALIDATION_ERROR',
      'Text filter requires a text column',
    );

  const values = Array.isArray(filter.value) ? filter.value : [filter.value];
  if (
    (filter.op === 'in' && values.length === 0) ||
    (filter.op === 'between' && values.length !== 2) ||
    (filter.op !== 'in' && filter.op !== 'between' && values.length !== 1) ||
    !values.every((value) => filterValueMatches(column.type, value))
  )
    throw new ReportError(
      400,
      'VALIDATION_ERROR',
      'Filter value does not match its column type',
    );
}

export function validateReportDefinition(
  dataset: Dataset,
  visible: DatasetColumn[],
  definition: ReportDefinition,
): void {
  resolveColumns(dataset, visible, definition);
  const filters = definition.filters.map((filter) =>
    tierCheck(visible, dataset, filter.column, 'filter'),
  );
  definition.filters.forEach((filter, index) => {
    const column = filters[index];
    if (!column)
      throw new ReportError(400, 'VALIDATION_ERROR', 'Unknown filter column');
    validateFilter(filter, column);
  });
  const groupColumns = definition.groupBy.map((key) =>
    tierCheck(visible, dataset, key, 'group'),
  );
  if (
    definition.timeGrain &&
    (groupColumns.length !== 1 ||
      !['date', 'datetime'].includes(groupColumns[0]?.type ?? ''))
  )
    throw new ReportError(
      400,
      'VALIDATION_ERROR',
      'A time period requires one date or datetime group column',
    );
  definition.aggregates.forEach((aggregate) => {
    if (aggregate.column === 'id' && aggregate.fn === 'count') return;
    const column = tierCheck(visible, dataset, aggregate.column, 'aggregate');
    if (
      ['sum', 'avg'].includes(aggregate.fn) &&
      column.type !== 'number' &&
      column.type !== 'money'
    )
      throw new ReportError(
        400,
        'VALIDATION_ERROR',
        'Sum and average require a numeric column',
      );
  });
}

export function reportUsesRestrictedColumns(
  dataset: Dataset,
  definition: ReportDefinition,
): string[] {
  const keys = new Set([
    ...definition.columns,
    ...definition.filters.map((filter) => filter.column),
    ...definition.groupBy,
    ...definition.aggregates.map((aggregate) => aggregate.column),
  ]);
  return dataset.columns
    .filter((column) => keys.has(column.key) && column.tier === 'restricted')
    .map((column) => column.key);
}

function columnExpression(column: DatasetColumn): RawBuilder<unknown> {
  if (column.type === 'money')
    return sql`(${/* @sql-raw-safe: static report dataset column source. */ sql.raw(column.source)})::numeric / 100`;
  return /* @sql-raw-safe: static report dataset column source. */ sql.raw(
    column.source,
  );
}

function groupExpression(
  column: DatasetColumn,
  timeGrain: ReportDefinition['timeGrain'],
): RawBuilder<unknown> {
  if (!timeGrain) return columnExpression(column);
  const grain = {
    day: sql`'day'`,
    week: sql`'week'`,
    month: sql`'month'`,
    year: sql`'year'`,
  }[timeGrain];
  return sql`date_trunc(${grain}, ${columnExpression(column)}::timestamp)`;
}

function filterExpression(
  filter: ReportFilter,
  column: DatasetColumn,
): RawBuilder<unknown> {
  const expr = columnExpression(column);
  const value = filter.value;
  switch (filter.op) {
    case 'is_null':
      return sql`${expr} IS NULL`;
    case 'not_null':
      return sql`${expr} IS NOT NULL`;
    case 'eq':
      return sql`${expr} = ${value ?? null}`;
    case 'ne':
      return sql`${expr} IS DISTINCT FROM ${value ?? null}`;
    case 'lt':
      return sql`${expr} < ${value}`;
    case 'lte':
      return sql`${expr} <= ${value}`;
    case 'gt':
      return sql`${expr} > ${value}`;
    case 'gte':
      return sql`${expr} >= ${value}`;
    case 'contains': {
      const escaped = String(value ?? '')
        .replaceAll('\\', '\\\\')
        .replaceAll('%', '\\%')
        .replaceAll('_', '\\_');
      return sql`${expr}::text ILIKE ${'%' + escaped + '%'} ESCAPE ${'\\'}`;
    }
    case 'starts_with': {
      const escaped = String(value ?? '')
        .replaceAll('\\', '\\\\')
        .replaceAll('%', '\\%')
        .replaceAll('_', '\\_');
      return sql`${expr}::text ILIKE ${escaped + '%'} ESCAPE ${'\\'}`;
    }
    case 'in': {
      const items = Array.isArray(value) ? value : [value];
      return sql`${expr} IN (${sql.join(items.map((item) => sql`${item}`))})`;
    }
    case 'between': {
      const range = Array.isArray(value) ? value : [];
      if (range.length !== 2)
        throw new ReportError(
          400,
          'VALIDATION_ERROR',
          'between requires two values',
        );
      return sql`${expr} BETWEEN ${range[0]} AND ${range[1]}`;
    }
  }
}

const AGGREGATE_SQL = {
  count: (expr: RawBuilder<unknown>) => sql`count(${expr})`,
  sum: (expr: RawBuilder<unknown>) => sql`coalesce(sum(${expr}), 0)`,
  avg: (expr: RawBuilder<unknown>) => sql`avg(${expr})`,
  min: (expr: RawBuilder<unknown>) => sql`min(${expr})`,
  max: (expr: RawBuilder<unknown>) => sql`max(${expr})`,
} as const;

function tierCheck(
  visible: DatasetColumn[],
  dataset: Dataset,
  key: string,
  what: string,
): DatasetColumn {
  const column = visible.find((c) => c.key === key);
  if (!column) {
    const exists = dataset.columns.some((c) => c.key === key);
    throw new ReportError(
      exists ? 403 : 400,
      exists ? 'FORBIDDEN' : 'VALIDATION_ERROR',
      exists
        ? `${what} column "${key}" is above your data tier`
        : `Unknown ${what} column "${key}"`,
    );
  }
  return column;
}

export async function runDatasetQuery(
  trx: OrgTransaction,
  orgId: string,
  dataset: Dataset,
  definition: ReportDefinition,
  selected: DatasetColumn[],
  visible: DatasetColumn[],
): Promise<ReportResult> {
  if (dataset.key === 'retention_cohorts')
    return runRetentionCohortQuery(trx, orgId, definition, selected);

  const filterColumns = definition.filters.map((filter) =>
    tierCheck(visible, dataset, filter.column, 'filter'),
  );
  definition.filters.forEach((filter, index) => {
    const column = filterColumns[index];
    if (!column)
      throw new ReportError(400, 'VALIDATION_ERROR', 'Unknown filter column');
    validateFilter(filter, column);
  });
  const grouped =
    definition.groupBy.length > 0 || definition.aggregates.length > 0;
  const groupColumns = definition.groupBy.map((key) =>
    tierCheck(visible, dataset, key, 'group'),
  );

  const selectParts: RawBuilder<unknown>[] = [];
  const outputColumns: { key: string; label: string; type: string }[] = [];
  if (grouped) {
    for (const column of groupColumns) {
      selectParts.push(
        sql`${groupExpression(column, definition.timeGrain)} AS ${sql.id(column.key)}`,
      );
      outputColumns.push({
        key: column.key,
        label: column.label,
        type: column.type,
      });
    }
    for (const aggregate of definition.aggregates) {
      const target =
        aggregate.column === 'id'
          ? null
          : tierCheck(visible, dataset, aggregate.column, 'aggregate');
      const key = `${aggregate.fn}_${aggregate.column}`;
      const expr = target
        ? (() => {
            const targetSource =
              /* @sql-raw-safe: authorized static dataset column. */ sql.raw(
                target.source,
              );
            const aggregateInput =
              target.type === 'money' && aggregate.fn !== 'count'
                ? sql`(${targetSource})::numeric / 100`
                : targetSource;
            return AGGREGATE_SQL[aggregate.fn](aggregateInput);
          })()
        : sql`count(*)`;
      selectParts.push(sql`${expr} AS ${sql.id(key)}`);
      outputColumns.push({
        key,
        label: `${aggregate.fn}(${target?.label ?? 'rows'})`,
        type: aggregate.fn === 'count' ? 'number' : (target?.type ?? 'number'),
      });
    }
  } else {
    for (const column of selected) {
      selectParts.push(
        sql`${columnExpression(column)} AS ${sql.id(column.key)}`,
      );
      outputColumns.push({
        key: column.key,
        label: column.label,
        type: column.type,
      });
    }
  }

  const joins = dataset.joins.map((join) => {
    const joinKeyword = join.kind === 'left' ? sql`LEFT JOIN` : sql`JOIN`;
    return sql`${joinKeyword} ${sql.table(join.table)} AS ${sql.id(join.alias)} ON (${/* @sql-raw-safe: join predicate is fixed in the server-owned dataset definition. */ sql.raw(join.on)}) AND ${sql.id(join.alias, 'org_id')} = t.org_id`;
  });
  const whereParts = [sql`t.org_id = ${orgId}`];
  for (const [index, filter] of definition.filters.entries()) {
    const column = filterColumns[index];
    if (!column) {
      throw new ReportError(400, 'VALIDATION_ERROR', 'Unknown filter column');
    }
    whereParts.push(filterExpression(filter, column));
  }
  const sortParts = definition.sort.map((sort) => {
    const output = outputColumns.find((c) => c.key === sort.column);
    if (!output)
      throw new ReportError(
        400,
        'VALIDATION_ERROR',
        `Cannot sort by "${sort.column}"`,
      );
    return sort.direction === 'desc'
      ? sql`${sql.id(sort.column)} DESC NULLS LAST`
      : sql`${sql.id(sort.column)} ASC NULLS LAST`;
  });

  const limit = Math.min(definition.limit ?? 200, 50_000);
  const groupByClause =
    grouped && groupColumns.length
      ? sql`GROUP BY ${sql.join(groupColumns.map((column) => groupExpression(column, definition.timeGrain)))}`
      : sql``;
  const orderClause = sortParts.length
    ? sql`ORDER BY ${sql.join(sortParts)}`
    : sql``;
  const query = sql<Record<string, unknown>>`
    SELECT ${sql.join(selectParts)}
    FROM ${sql.table(dataset.table)} AS t
    ${sql.join(joins, sql` `)}
    WHERE ${sql.join(whereParts, sql` AND `)}
    ${groupByClause}
    ${orderClause}
    LIMIT ${limit + 1}
  `;
  const result = await query.execute(trx);
  const truncated = result.rows.length > limit;
  const rows = result.rows
    .slice(0, limit)
    .map((row) => outputColumns.map((column) => row[column.key]));
  return { columns: outputColumns, rows, truncated };
}

interface RetentionCohortRow {
  current_year: number;
  previous_year: number;
  previous_participants: number;
  retained_participants: number;
  retention_rate_percent: number | null;
}

async function runRetentionCohortQuery(
  trx: OrgTransaction,
  orgId: string,
  definition: ReportDefinition,
  selected: DatasetColumn[],
): Promise<ReportResult> {
  if (
    definition.filters.length > 0 ||
    definition.groupBy.length > 0 ||
    definition.aggregates.length > 0 ||
    definition.timeGrain
  )
    throw new ReportError(
      400,
      'VALIDATION_ERROR',
      'Retention cohorts support column selection and sorting only',
    );
  if (
    definition.sort.some(
      (sort) => !selected.some((column) => column.key === sort.column),
    )
  )
    throw new ReportError(
      400,
      'VALIDATION_ERROR',
      'Retention cohorts can only sort by selected columns',
    );

  const result = await sql<RetentionCohortRow>`
    WITH season_people AS (
      SELECT DISTINCT
        EXTRACT(YEAR FROM s.starts_on)::integer AS year,
        r.person_id
      FROM registrations r
      JOIN programs p
        ON p.id = r.program_id AND p.org_id = r.org_id
      JOIN seasons s
        ON s.id = p.season_id AND s.org_id = p.org_id
      WHERE r.org_id = ${orgId}
        AND r.status = 'confirmed'
    ), people_by_year AS (
      SELECT year, count(*)::integer AS participant_count
      FROM season_people
      GROUP BY year
    )
    SELECT
      current_year.year AS current_year,
      previous_year.year AS previous_year,
      previous_year.participant_count AS previous_participants,
      count(DISTINCT previous_person.person_id)::integer AS retained_participants,
      ROUND(
        count(DISTINCT previous_person.person_id)::numeric * 100 /
          NULLIF(previous_year.participant_count, 0),
        1
      )::double precision AS retention_rate_percent
    FROM people_by_year current_year
    JOIN people_by_year previous_year
      ON previous_year.year = current_year.year - 1
    LEFT JOIN season_people current_person
      ON current_person.year = current_year.year
    LEFT JOIN season_people previous_person
      ON previous_person.year = previous_year.year
      AND previous_person.person_id = current_person.person_id
    GROUP BY
      current_year.year,
      previous_year.year,
      previous_year.participant_count
    ORDER BY current_year.year ASC
  `.execute(trx);

  const sortColumn = definition.sort[0];
  const sortedRows = sortColumn
    ? [...result.rows].sort((left, right) => {
        for (const sort of definition.sort) {
          const a = left[sort.column as keyof RetentionCohortRow];
          const b = right[sort.column as keyof RetentionCohortRow];
          if (a === b) continue;
          if (a === null) return 1;
          if (b === null) return -1;
          const order =
            typeof a === 'number' && typeof b === 'number'
              ? a - b
              : String(a).localeCompare(String(b));
          if (order !== 0) return sort.direction === 'desc' ? -order : order;
        }
        return 0;
      })
    : result.rows;
  const limit = Math.min(definition.limit ?? 200, 50_000);
  const rows = sortedRows.slice(0, limit);
  return {
    columns: selected.map(({ key, label, type }) => ({ key, label, type })),
    rows: rows.map((row) =>
      selected.map((column) => row[column.key as keyof RetentionCohortRow]),
    ),
    truncated: sortedRows.length > limit,
  };
}

export async function datasetAvailable(
  trx: OrgTransaction,
  dataset: Dataset,
): Promise<boolean> {
  for (const table of dataset.requiredTables) {
    const result = await sql<{ present: string | null }>`
      SELECT to_regclass(${'public.' + table})::text AS present
    `.execute(trx);
    if (!result.rows[0]?.present) return false;
  }
  return true;
}
