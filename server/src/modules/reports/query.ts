import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';

import type { OrgTransaction } from '../../db/withOrg';
import { datasetByKey, tierAllowed } from '@shared/reports/datasets';
import type { Dataset, DatasetColumn } from '@shared/reports/datasets';
import type { ReportDefinition, ReportFilter } from '@shared/schemas/reports';

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
  const dataset = datasetByKey.get(key);
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
        'COLUMN_FORBIDDEN',
        exists
          ? `Column "${key}" is above your data tier`
          : `Unknown column "${key}"`,
      );
    }
  }
  return keys.map((key) => visible.find((column) => column.key === key)!);
}

function columnExpression(column: DatasetColumn): RawBuilder<unknown> {
  if (column.type === 'money')
    return sql`(${sql.raw(column.source)})::numeric / 100`;
  return sql.raw(column.source);
}

function filterExpression(
  filter: ReportFilter,
  column: DatasetColumn,
): RawBuilder<unknown> {
  const expr = sql.raw(column.source);
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
    case 'contains':
      return sql`${expr}::text ILIKE ${'%' + String(value ?? '') + '%'}`;
    case 'starts_with':
      return sql`${expr}::text ILIKE ${String(value ?? '') + '%'}`;
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
      exists ? 'COLUMN_FORBIDDEN' : 'VALIDATION_ERROR',
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
  const filterColumns = definition.filters.map((filter) =>
    tierCheck(visible, dataset, filter.column, 'filter'),
  );
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
        sql`${columnExpression(column)} AS ${sql.id(column.key)}`,
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
        ? AGGREGATE_SQL[aggregate.fn](
            sql.raw(
              target.type === 'money' && aggregate.fn !== 'count'
                ? `(${target.source})::numeric / 100`
                : target.source,
            ),
          )
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

  const joins = dataset.joins.map((join) =>
    sql`${sql.raw(join.kind === 'left' ? 'LEFT JOIN' : 'JOIN')} ${sql.table(join.table)} ${sql.raw('AS')} ${sql.id(join.alias)} ON ${sql.raw(join.on)}`,
  );
  const whereParts = [
    sql`t.org_id = ${orgId}`,
    ...definition.filters.map((filter, index) =>
      filterExpression(filter, filterColumns[index]!),
    ),
  ];
  const sortParts = definition.sort.map((sort) => {
    const output = outputColumns.find((c) => c.key === sort.column);
    if (!output)
      throw new ReportError(
        400,
        'VALIDATION_ERROR',
        `Cannot sort by "${sort.column}"`,
      );
    return sql`${sql.id(sort.column)} ${sql.raw(sort.direction === 'desc' ? 'DESC' : 'ASC')} NULLS LAST`;
  });

  const limit = Math.min(definition.limit ?? 200, 50_000);
  const groupByClause =
    grouped && groupColumns.length
      ? sql`GROUP BY ${sql.join(groupColumns.map((c) => sql.raw(c.source)))}`
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
