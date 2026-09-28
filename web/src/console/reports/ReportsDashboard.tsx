import {
  reportDatasetListSchema,
  reportDefinitionSchema,
  reportPreviewResponseSchema,
} from '@shared/schemas/reports';
import type { ReportDefinition } from '@shared/schemas/reports';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { apiGet, apiPost } from '../../api/client';
import { Chart } from '../../ui/extended';
import { Button, Card } from '../../ui/primitives';

import './report.css';

type ReportSummary = {
  key: string;
  title: string;
  definition: ReportDefinition;
  valueKind: 'count' | 'money' | 'percent';
};

const summaries: readonly ReportSummary[] = [
  {
    key: 'registration-pace',
    title: 'Registration pace (past 12 months)',
    valueKind: 'count',
    definition: reportDefinitionSchema.parse({
      dataset: 'registrations',
      columns: ['created_at'],
      filters: [],
      groupBy: ['created_at'],
      timeGrain: 'month',
      aggregates: [{ fn: 'count', column: 'id' }],
      sort: [{ column: 'created_at', direction: 'asc' }],
      limit: 12,
    }),
  },
  {
    key: 'registrations-by-program',
    title: 'Registrations by program',
    valueKind: 'count',
    definition: reportDefinitionSchema.parse({
      dataset: 'registrations',
      columns: ['program_name'],
      filters: [],
      groupBy: ['program_name'],
      aggregates: [{ fn: 'count', column: 'id' }],
      sort: [{ column: 'count_id', direction: 'desc' }],
      limit: 12,
    }),
  },
  {
    key: 'revenue-by-program',
    title: 'Revenue by program',
    valueKind: 'money',
    definition: reportDefinitionSchema.parse({
      dataset: 'invoice_lines',
      columns: ['program_name'],
      filters: [],
      groupBy: ['program_name'],
      aggregates: [{ fn: 'sum', column: 'amount_cents' }],
      sort: [{ column: 'sum_amount_cents', direction: 'desc' }],
      limit: 12,
    }),
  },
  {
    key: 'aging-receivables',
    title: 'Aging receivables',
    valueKind: 'money',
    definition: reportDefinitionSchema.parse({
      dataset: 'invoices',
      columns: ['aging_bucket'],
      filters: [],
      groupBy: ['aging_bucket'],
      aggregates: [{ fn: 'sum', column: 'balance_cents' }],
      sort: [{ column: 'aging_bucket', direction: 'asc' }],
      limit: 12,
    }),
  },
  {
    key: 'retention-year-over-year',
    title: 'Participant retention year over year',
    valueKind: 'percent',
    definition: reportDefinitionSchema.parse({
      dataset: 'retention_cohorts',
      columns: [
        'current_year',
        'previous_year',
        'previous_participants',
        'retained_participants',
        'retention_rate_percent',
      ],
      filters: [],
      groupBy: [],
      aggregates: [],
      sort: [{ column: 'current_year', direction: 'asc' }],
      limit: 12,
    }),
  },
  {
    key: 'credential-compliance',
    title: 'Credential compliance',
    valueKind: 'percent',
    definition: reportDefinitionSchema.parse({
      dataset: 'credentials',
      columns: ['status'],
      filters: [{ column: 'status', op: 'ne', value: 'revoked' }],
      groupBy: ['status'],
      aggregates: [{ fn: 'count', column: 'id' }],
      sort: [{ column: 'status', direction: 'asc' }],
      limit: 12,
    }),
  },
];

type ReportPreview = ReturnType<typeof reportPreviewResponseSchema.parse>;

function numberValue(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function chartValues(
  summary: ReportSummary,
  preview: ReportPreview,
): { label: string; value: number }[] {
  if (summary.key === 'credential-compliance') {
    const statusIndex = preview.columns.findIndex(
      (column) => column.key === 'status',
    );
    const countIndex = preview.columns.findIndex(
      (column) => column.key === 'count_id',
    );
    if (statusIndex < 0 || countIndex < 0) return [];
    const counts = preview.rows.flatMap((row) => {
      const status = row[statusIndex];
      const count = numberValue(row[countIndex]);
      return typeof status === 'string' && count !== null
        ? [{ status, count }]
        : [];
    });
    const total = counts.reduce((sum, item) => sum + item.count, 0);
    if (total === 0) return [];
    const verified =
      counts.find((item) => item.status === 'verified')?.count ?? 0;
    const verifiedPercent = (verified / total) * 100;
    return [
      { label: 'Verified', value: verifiedPercent },
      { label: 'Needs attention', value: 100 - verifiedPercent },
    ];
  }

  if (summary.definition.dataset === 'retention_cohorts') {
    const yearIndex = preview.columns.findIndex(
      (column) => column.key === 'current_year',
    );
    const rateIndex = preview.columns.findIndex(
      (column) => column.key === 'retention_rate_percent',
    );
    if (yearIndex < 0 || rateIndex < 0) return [];
    return preview.rows.flatMap((row) => {
      const value = numberValue(row[rateIndex]);
      const year = row[yearIndex];
      return value === null ||
        (typeof year !== 'number' && typeof year !== 'string')
        ? []
        : [{ label: typeof year === 'number' ? year.toString() : year, value }];
    });
  }

  const groupKey = summary.definition.groupBy[0];
  const aggregate = summary.definition.aggregates[0];
  if (!groupKey || !aggregate) return [];
  const groupIndex = preview.columns.findIndex(
    (column) => column.key === groupKey,
  );
  const valueIndex = preview.columns.findIndex(
    (column) => column.key === `${aggregate.fn}_${aggregate.column}`,
  );
  if (groupIndex < 0 || valueIndex < 0) return [];
  return preview.rows.flatMap((row) => {
    const value = numberValue(row[valueIndex]);
    const label = row[groupIndex];
    if (
      value === null ||
      (typeof label !== 'number' && typeof label !== 'string')
    )
      return [];
    return [
      {
        label:
          summary.key === 'registration-pace'
            ? new Intl.DateTimeFormat('en-US', {
                month: 'short',
                year: 'numeric',
                timeZone: 'UTC',
              }).format(new Date(String(label)))
            : typeof label === 'number'
              ? label.toString()
              : label,
        value: summary.valueKind === 'money' ? value / 100 : value,
      },
    ];
  });
}

function formatValue(kind: ReportSummary['valueKind'], value: number): string {
  if (kind === 'money') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(value);
  }
  if (kind === 'percent') return `${value.toFixed(1)}%`;
  return new Intl.NumberFormat('en-US').format(value);
}

function requiredColumns(definition: ReportDefinition): Set<string> {
  return new Set([
    ...definition.columns,
    ...definition.groupBy,
    ...definition.filters.map(({ column }) => column),
    ...definition.aggregates.map(({ column }) => column),
  ]);
}

export function ReportsDashboard({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const base = `/reports/orgs/${encodeURIComponent(orgId)}`;
  const dashboardSummaries = useMemo(() => {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCMonth(start.getUTCMonth() - 11);
    const startAt = start.toISOString();
    return summaries.map((summary) =>
      summary.key === 'registration-pace'
        ? {
            ...summary,
            definition: reportDefinitionSchema.parse({
              ...summary.definition,
              filters: [{ column: 'created_at', op: 'gte', value: startAt }],
            }),
          }
        : summary,
    );
  }, []);
  const datasets = useQuery({
    queryKey: ['reports', orgId, 'datasets'],
    queryFn: () => apiGet(`${base}/datasets`, reportDatasetListSchema),
  });
  const eligibleSummaries = dashboardSummaries.filter((summary) => {
    const dataset = datasets.data?.items.find(
      (item) => item.key === summary.definition.dataset,
    );
    if (!dataset?.available) return false;
    const available = new Set(dataset.columns.map(({ key }) => key));
    return [...requiredColumns(summary.definition)].every((key) =>
      available.has(key),
    );
  });
  const previews = useQueries({
    queries: eligibleSummaries.map((summary) => ({
      queryKey: ['reports', orgId, 'dashboard', summary.key],
      queryFn: () =>
        apiPost(
          `${base}/reports/preview`,
          { definition: summary.definition },
          reportPreviewResponseSchema,
        ),
      staleTime: 30_000,
    })),
  });

  return (
    <section
      className="report-dashboard"
      aria-labelledby="report-dashboard-title"
    >
      <header>
        <h2 id="report-dashboard-title">Organization overview</h2>
        <p>
          Registration pace, finances, credential compliance, and participant
          retention.
        </p>
      </header>
      {datasets.isPending && <p role="status">Loading report access…</p>}
      {datasets.isError && (
        <p role="alert">The organization overview is unavailable.</p>
      )}
      {!datasets.isPending &&
        !datasets.isError &&
        eligibleSummaries.length === 0 && (
          <p>No overview reports are available to your role.</p>
        )}
      {eligibleSummaries.length > 0 && (
        <div className="report-dashboard__grid">
          {eligibleSummaries.map((summary, index) => {
            const preview = previews[index];
            const values = preview?.data
              ? chartValues(summary, preview.data)
              : [];
            return (
              <Card
                key={summary.key}
                className="report-dashboard__card"
                aria-labelledby={`report-dashboard-${summary.key}`}
              >
                <h3 id={`report-dashboard-${summary.key}`}>{summary.title}</h3>
                {preview?.isPending && (
                  <p role="status">Loading {summary.title.toLowerCase()}…</p>
                )}
                {preview?.isError && (
                  <div role="alert">
                    <p>This summary could not be loaded.</p>
                    <Button
                      secondary
                      onClick={() => {
                        void preview.refetch();
                      }}
                    >
                      Retry
                    </Button>
                  </div>
                )}
                {preview?.isSuccess && values.length > 0 && (
                  <Chart
                    title={summary.title}
                    values={values}
                    tone={summary.valueKind === 'money' ? 'ok' : 'accent'}
                    valueFormatter={(value) =>
                      formatValue(summary.valueKind, value)
                    }
                  />
                )}
                {preview?.isSuccess && values.length === 0 && (
                  <p>No records are available for this report.</p>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
