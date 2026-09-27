import { authMeResponseSchema } from '@shared/schemas/auth';
import { orgRoleSchema } from '@shared/schemas/orgs';
import {
  reportDatasetListSchema,
  reportDefinitionSchema,
  reportPreviewResponseSchema,
  reportScheduleCreateResponseSchema,
  reportScheduleListSchema,
  reportScheduleUpdateResponseSchema,
  savedReportCreateResponseSchema,
  savedReportListSchema,
  savedReportResponseSchema,
} from '@shared/schemas/reports';
import type { ReportDefinition, ReportFilter } from '@shared/schemas/reports';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Select,
} from '../../ui/primitives';

import './report.css';

type DatasetList = z.output<typeof reportDatasetListSchema>;
type Dataset = DatasetList['items'][number];
type DatasetColumn = Dataset['columns'][number];
type SavedReport = z.output<typeof savedReportResponseSchema>;
type ReportPreview = z.output<typeof reportPreviewResponseSchema>;
type Schedule = z.output<typeof reportScheduleListSchema>['items'][number];
type TimeGrain = 'day' | 'week' | 'month' | 'year';
type ReportPreset = {
  label: string;
  dataset: string;
  columns: string[];
  groupBy: string[];
  timeGrain?: TimeGrain;
  aggregate?: { fn: 'count' | 'sum'; column: string };
  sortColumn: string;
  filters?: ReportFilter[];
};

const reportPresets: readonly ReportPreset[] = [
  {
    label: 'Retention year over year',
    dataset: 'retention_cohorts',
    columns: [
      'current_year',
      'previous_year',
      'previous_participants',
      'retained_participants',
      'retention_rate_percent',
    ],
    groupBy: [],
    sortColumn: 'current_year',
  },
  {
    label: 'Registration pace',
    dataset: 'registrations',
    columns: ['id'],
    groupBy: ['created_at'],
    timeGrain: 'week',
    aggregate: { fn: 'count', column: 'id' },
    sortColumn: 'created_at',
  },
  {
    label: 'Revenue by program',
    dataset: 'invoice_lines',
    columns: ['program_name'],
    groupBy: ['program_name'],
    aggregate: { fn: 'sum', column: 'amount_cents' },
    sortColumn: 'sum_amount_cents',
  },
  {
    label: 'Registration by division',
    dataset: 'registrations',
    columns: ['division_name'],
    groupBy: ['division_name'],
    aggregate: { fn: 'count', column: 'id' },
    sortColumn: 'count_id',
  },
  {
    label: 'Registration by program',
    dataset: 'registrations',
    columns: ['program_name'],
    groupBy: ['program_name'],
    aggregate: { fn: 'count', column: 'id' },
    sortColumn: 'count_id',
  },
  {
    label: 'Registration by age group',
    dataset: 'registrations',
    columns: ['age_label'],
    groupBy: ['age_label'],
    aggregate: { fn: 'count', column: 'id' },
    sortColumn: 'age_label',
  },
  {
    label: 'Registration by gender',
    dataset: 'registrations',
    columns: ['person_gender'],
    groupBy: ['person_gender'],
    aggregate: { fn: 'count', column: 'id' },
    sortColumn: 'person_gender',
  },
  {
    label: 'Registration by ZIP/postal code',
    dataset: 'registrations',
    columns: ['household_postal_code'],
    groupBy: ['household_postal_code'],
    aggregate: { fn: 'count', column: 'id' },
    sortColumn: 'household_postal_code',
  },
  {
    label: 'Aging receivables',
    dataset: 'invoices',
    columns: ['aging_bucket'],
    groupBy: ['aging_bucket'],
    aggregate: { fn: 'sum', column: 'balance_cents' },
    sortColumn: 'aging_bucket',
  },
  {
    label: 'Credential compliance status',
    dataset: 'credentials',
    columns: ['status'],
    groupBy: ['status'],
    aggregate: { fn: 'count', column: 'id' },
    sortColumn: 'status',
  },
  {
    label: 'Installment forecast',
    dataset: 'installments',
    columns: ['due_on'],
    groupBy: ['due_on'],
    timeGrain: 'month',
    aggregate: { fn: 'sum', column: 'amount_cents' },
    sortColumn: 'due_on',
  },
  {
    label: 'Attendance by event status',
    dataset: 'attendance',
    columns: ['status'],
    groupBy: ['status'],
    aggregate: { fn: 'count', column: 'id' },
    sortColumn: 'status',
  },
  {
    label: 'Payouts by settlement status',
    dataset: 'payouts',
    columns: ['status'],
    groupBy: ['status'],
    aggregate: { fn: 'sum', column: 'amount_cents' },
    sortColumn: 'status',
  },
  {
    label: 'Official pay by official',
    dataset: 'officials_pay',
    columns: ['person_name'],
    groupBy: ['person_name'],
    aggregate: { fn: 'sum', column: 'total_cents' },
    sortColumn: 'sum_total_cents',
  },
  {
    label: 'Donations by campaign',
    dataset: 'donations',
    columns: ['campaign_name'],
    groupBy: ['campaign_name'],
    aggregate: { fn: 'sum', column: 'amount_cents' },
    sortColumn: 'sum_amount_cents',
  },
  {
    label: 'Volunteer completion by status',
    dataset: 'volunteers',
    columns: ['status'],
    groupBy: ['status'],
    aggregate: { fn: 'count', column: 'id' },
    sortColumn: 'status',
  },
  {
    label: 'Financial aid awarded by program',
    dataset: 'aid_awards',
    columns: ['program_name'],
    filters: [
      {
        column: 'status',
        op: 'in',
        value: ['awarded', 'partially_awarded'],
      },
    ],
    groupBy: ['program_name'],
    aggregate: { fn: 'sum', column: 'award_cents' },
    sortColumn: 'sum_award_cents',
  },
  {
    label: 'Uniform quantities by size',
    dataset: 'uniform_sizes',
    columns: ['product_name', 'size'],
    filters: [
      { column: 'product_kind', op: 'eq', value: 'uniform' },
      {
        column: 'order_status',
        op: 'in',
        value: ['paid', 'fulfilling', 'fulfilled'],
      },
    ],
    groupBy: ['product_name', 'size'],
    aggregate: { fn: 'sum', column: 'quantity' },
    sortColumn: 'product_name',
  },
];

const filterOperators = [
  { value: 'eq', label: 'is' },
  { value: 'ne', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'at most' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'at least' },
  { value: 'between', label: 'between' },
  { value: 'is_null', label: 'is blank' },
  { value: 'not_null', label: 'is not blank' },
] as const;

const aggregateOptions = [
  { value: 'count', label: 'Count' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
] as const;

function requestHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Athlentry-Request': '1',
  };
}

async function putJson<T extends z.ZodType>(
  path: string,
  body: unknown,
  schema: T,
): Promise<z.output<T>> {
  const response = await fetch(`/api/v1${path}`, {
    method: 'PUT',
    credentials: 'include',
    headers: requestHeaders(),
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(json);
    throw new Error(
      parsed.success
        ? parsed.data.error.message
        : 'The change could not be saved.',
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error('The response could not be read.');
  return parsed.data;
}

async function download(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<void> {
  const request: RequestInit = {
    method,
    credentials: 'include',
    ...(method === 'GET'
      ? {}
      : { headers: requestHeaders(), body: JSON.stringify(body) }),
  };
  const response = await fetch(`/api/v1${path}`, {
    ...request,
  });
  if (!response.ok) {
    const json: unknown = await response.json().catch(() => null);
    const parsed = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(json);
    throw new Error(
      parsed.success
        ? parsed.data.error.message
        : 'The export could not be created.',
    );
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const fileName = response.headers
    .get('Content-Disposition')
    ?.match(/filename="([^"]+)"/)?.[1];
  anchor.href = objectUrl;
  anchor.download = fileName ?? 'report.csv';
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 0);
}

function freshDefinition(dataset: Dataset): ReportDefinition {
  return {
    dataset: dataset.key,
    columns: dataset.columns
      .slice(0, Math.min(6, dataset.columns.length))
      .map((column) => column.key),
    filters: [],
    groupBy: [],
    aggregates: [],
    sort: [],
    limit: 200,
  };
}

function filterValue(filter: ReportFilter, column: DatasetColumn): unknown {
  if (filter.op === 'is_null' || filter.op === 'not_null') return undefined;
  const raw = Array.isArray(filter.value)
    ? filter.value.map((item) => String(item)).join('|')
    : typeof filter.value === 'string' ||
        typeof filter.value === 'number' ||
        typeof filter.value === 'boolean'
      ? String(filter.value)
      : '';
  if (filter.op === 'between') {
    const [first = '', second = ''] = raw.split('|', 2);
    return [parseScalar(first, column), parseScalar(second, column)];
  }
  if (filter.op === 'in')
    return raw.split('|').map((value) => parseScalar(value, column));
  return parseScalar(raw, column);
}

function parseScalar(
  value: string,
  column: DatasetColumn,
): string | number | boolean {
  if (column.type === 'number' || column.type === 'money') return Number(value);
  if (column.type === 'boolean') return value === 'true';
  return value;
}

function displayValue(value: unknown, column?: DatasetColumn): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date)
    return column?.type === 'datetime'
      ? value.toLocaleString()
      : value.toLocaleDateString();
  if (
    typeof value === 'string' &&
    (column?.type === 'date' || column?.type === 'datetime')
  ) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()))
      return column.type === 'datetime'
        ? date.toLocaleString()
        : date.toLocaleDateString();
  }
  if (column?.type === 'money' && typeof value === 'number') {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
    }).format(value);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Intl.NumberFormat().format(value);
  if (Array.isArray(value))
    return value.map((item) => displayValue(item)).join(', ');
  if (typeof value === 'object') return 'Record';
  return '—';
}

function chartLabel(value: unknown): string {
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value !== 'string') return displayValue(value);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
        timestamp,
      );
}

function chartNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function previewChart(
  preview: ReportPreview,
  definition: ReportDefinition,
): {
  label: string;
  aggregate: string;
  data: { label: string; value: number }[];
} | null {
  if (definition.dataset === 'retention_cohorts') {
    const yearIndex = preview.columns.findIndex(
      (column) => column.key === 'current_year',
    );
    const rateIndex = preview.columns.findIndex(
      (column) => column.key === 'retention_rate_percent',
    );
    if (yearIndex < 0 || rateIndex < 0) return null;
    const yearColumn = preview.columns[yearIndex];
    const rateColumn = preview.columns[rateIndex];
    if (!yearColumn || !rateColumn) return null;
    return {
      label: yearColumn.label,
      aggregate: rateColumn.label,
      data: preview.rows.flatMap((row) => {
        const value = chartNumber(row[rateIndex]);
        return value === null
          ? []
          : [{ label: chartLabel(row[yearIndex]), value }];
      }),
    };
  }
  const groupKey = definition.groupBy[0];
  const aggregateDefinition = definition.aggregates[0];
  if (
    !groupKey ||
    definition.groupBy.length !== 1 ||
    !aggregateDefinition ||
    definition.aggregates.length !== 1
  )
    return null;
  const groupIndex = preview.columns.findIndex(
    (column) => column.key === groupKey,
  );
  const valueKey = `${aggregateDefinition.fn}_${aggregateDefinition.column}`;
  const valueIndex = preview.columns.findIndex(
    (column) => column.key === valueKey,
  );
  const groupColumn = preview.columns[groupIndex];
  const valueColumn = preview.columns[valueIndex];
  if (groupIndex < 0 || valueIndex < 0 || !groupColumn || !valueColumn)
    return null;
  return {
    label: groupColumn.label,
    aggregate: valueColumn.label,
    data: preview.rows.flatMap((row) => {
      const value = chartNumber(row[valueIndex]);
      return value === null
        ? []
        : [{ label: chartLabel(row[groupIndex]), value }];
    }),
  };
}

function tierName(tier: DatasetColumn['tier']): string {
  return tier === 'public'
    ? 'Public'
    : `${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
}

export function ReportBuilder({ orgId }: { orgId: string }): React.JSX.Element {
  const base = `/reports/orgs/${encodeURIComponent(orgId)}`;
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [savedReports, setSavedReports] = useState<SavedReport[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [account, setAccount] = useState<z.output<
    typeof authMeResponseSchema
  > | null>(null);
  const [datasetKey, setDatasetKey] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [filters, setFilters] = useState<ReportFilter[]>([]);
  const [groupBy, setGroupBy] = useState<string[]>([]);
  const [timeGrain, setTimeGrain] = useState<TimeGrain | ''>('');
  const [aggregate, setAggregate] = useState('');
  const [aggregateColumn, setAggregateColumn] = useState('');
  const [sortColumn, setSortColumn] = useState('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [previewDefinition, setPreviewDefinition] =
    useState<ReportDefinition | null>(null);
  const [reportName, setReportName] = useState('');
  const [sharedRoles, setSharedRoles] = useState<string[]>([]);
  const [selectedReport, setSelectedReport] = useState<SavedReport | null>(
    null,
  );
  const [cadence, setCadence] = useState<'daily' | 'weekly' | 'monthly'>(
    'weekly',
  );
  const [runAt, setRunAt] = useState('08:00');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const dataset = datasets.find((item) => item.key === datasetKey);
  const columnByKey = useMemo(
    () =>
      new Map((dataset?.columns ?? []).map((column) => [column.key, column])),
    [dataset],
  );
  const numericColumns =
    dataset?.columns.filter(
      (column) => column.type === 'number' || column.type === 'money',
    ) ?? [];

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [datasetResult, reportResult, scheduleResult, accountResult] =
        await Promise.all([
          apiGet(`${base}/datasets`, reportDatasetListSchema),
          apiGet(`${base}/saved-reports`, savedReportListSchema),
          apiGet(`${base}/report-schedules`, reportScheduleListSchema),
          apiGet('/auth/me', authMeResponseSchema),
        ]);
      const available = datasetResult.items.filter((item) => item.available);
      setDatasets(available);
      setSavedReports(reportResult.items);
      setSchedules(scheduleResult.items);
      setAccount(accountResult);
      const first = available[0];
      if (first) {
        setDatasetKey((current) => current || first.key);
        setColumns((current) =>
          current.length ? current : freshDefinition(first).columns,
        );
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Reports are unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  function chooseDataset(key: string) {
    const next = datasets.find((item) => item.key === key);
    setDatasetKey(key);
    setColumns(next ? freshDefinition(next).columns : []);
    setFilters([]);
    setGroupBy([]);
    setTimeGrain('');
    setAggregate('');
    setAggregateColumn('');
    setPreview(null);
    setSelectedReport(null);
  }

  function definition(): ReportDefinition {
    if (!dataset) throw new Error('Choose an available dataset first.');
    if (columns.length === 0) throw new Error('Choose at least one column.');
    const resolvedFilters = filters.map((filter) => {
      const column = columnByKey.get(filter.column);
      if (!column) throw new Error('A filter column is no longer available.');
      const value = filterValue(filter, column);
      return { ...filter, ...(value === undefined ? {} : { value }) };
    });
    return reportDefinitionSchema.parse({
      dataset: dataset.key,
      columns,
      filters: resolvedFilters,
      groupBy,
      ...(timeGrain ? { timeGrain } : {}),
      aggregates:
        aggregate && aggregateColumn
          ? [{ fn: aggregate, column: aggregateColumn }]
          : [],
      sort: sortColumn
        ? [{ column: sortColumn, direction: sortDirection }]
        : [],
      limit: 200,
    });
  }

  async function runPreview() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const currentDefinition = definition();
      const result = await apiPost(
        `${base}/reports/preview`,
        { definition: currentDefinition },
        reportPreviewResponseSchema,
      );
      setPreview(result);
      setPreviewDefinition(currentDefinition);
      setNotice(`${String(result.rows.length)} preview rows loaded.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Preview failed.');
    } finally {
      setBusy(false);
    }
  }

  async function saveReport() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const body = {
        name: reportName.trim(),
        definition: definition(),
        sharedRoles,
      };
      if (selectedReport) {
        const saved = await putJson(
          `${base}/saved-reports/${encodeURIComponent(selectedReport.id)}`,
          { ...body, expectedVersion: selectedReport.version },
          savedReportResponseSchema,
        );
        setSelectedReport(saved);
      } else {
        const result = await apiPost(
          `${base}/saved-reports`,
          body,
          savedReportCreateResponseSchema,
        );
        setSelectedReport(result.report);
      }
      setNotice('Report saved.');
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Report could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  function loadSavedReport(report: SavedReport) {
    const source = datasets.find(
      (item) => item.key === report.definition.dataset,
    );
    if (!source) {
      setError(
        'This report uses a dataset that is not available to your role.',
      );
      return;
    }
    setSelectedReport(report);
    setReportName(report.name);
    setDatasetKey(source.key);
    setColumns(report.definition.columns);
    setFilters(
      report.definition.filters.map((filter) => ({
        ...filter,
        value: Array.isArray(filter.value)
          ? filter.value.join('|')
          : filter.value,
      })),
    );
    setGroupBy(report.definition.groupBy);
    setTimeGrain(report.definition.timeGrain ?? '');
    const firstAggregate = report.definition.aggregates[0];
    setAggregate(firstAggregate?.fn ?? '');
    setAggregateColumn(firstAggregate?.column ?? '');
    const firstSort = report.definition.sort[0];
    setSortColumn(firstSort?.column ?? '');
    setSortDirection(firstSort?.direction ?? 'asc');
    setSharedRoles(report.sharedRoles);
    setPreview(null);
    setError('');
  }

  async function exportCurrent(format: 'csv' | 'xlsx') {
    setBusy(true);
    setError('');
    try {
      await download(`${base}/reports/export`, 'POST', {
        definition: definition(),
        format,
      });
      setNotice(`${format.toUpperCase()} export downloaded.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }

  async function scheduleReport() {
    if (!selectedReport || !account) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const [hours = '8', minutes = '0'] = runAt.split(':');
      const result = await apiPost(
        `${base}/report-schedules`,
        {
          savedReportId: selectedReport.id,
          cadence,
          recipientAccountIds: [account.id],
          delivery: 'link',
          format: 'csv',
          runAtMinute: Number(hours) * 60 + Number(minutes),
        },
        reportScheduleCreateResponseSchema,
      );
      setSchedules((current) => [
        result.schedule,
        ...current.filter((item) => item.id !== result.schedule.id),
      ]);
      setNotice(`Secure report link scheduled for ${account.email}.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Schedule could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleSchedule(schedule: Schedule) {
    setBusy(true);
    setError('');
    try {
      const result = await putJson(
        `${base}/report-schedules/${encodeURIComponent(schedule.id)}`,
        {
          status: schedule.status === 'active' ? 'paused' : 'active',
          expectedVersion: schedule.version,
        },
        reportScheduleUpdateResponseSchema,
      );
      setSchedules((current) =>
        current.map((item) =>
          item.id === schedule.id ? result.schedule : item,
        ),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Schedule could not be updated.',
      );
    } finally {
      setBusy(false);
    }
  }

  function addFilter() {
    const first = dataset?.columns[0];
    if (!first) return;
    setFilters((current) => [
      ...current,
      { column: first.key, op: 'eq', value: '' },
    ]);
  }

  function chooseGroup(columnKey: string) {
    setGroupBy(columnKey ? [columnKey] : []);
    const type = columnByKey.get(columnKey)?.type;
    if (!['date', 'datetime'].includes(type ?? '')) setTimeGrain('');
  }

  function applyPreset(preset: ReportPreset) {
    const source = datasets.find((item) => item.key === preset.dataset);
    if (!source) return;
    const availableColumns = new Set(
      source.columns.map((column) => column.key),
    );
    if (
      !preset.columns.every((key) => availableColumns.has(key)) ||
      !preset.groupBy.every((key) => availableColumns.has(key)) ||
      !(preset.filters ?? []).every((filter) =>
        availableColumns.has(filter.column),
      ) ||
      (preset.aggregate &&
        preset.aggregate.fn !== 'count' &&
        !availableColumns.has(preset.aggregate.column))
    ) {
      setError(
        'This report preset is not available for the current data role.',
      );
      return;
    }
    setDatasetKey(source.key);
    setColumns(preset.columns);
    setFilters(preset.filters ?? []);
    setGroupBy(preset.groupBy);
    setTimeGrain(preset.timeGrain ?? '');
    setAggregate(preset.aggregate?.fn ?? '');
    setAggregateColumn(preset.aggregate?.column ?? '');
    setSortColumn(preset.sortColumn);
    setSortDirection('asc');
    setReportName(preset.label);
    setSharedRoles([]);
    setSelectedReport(null);
    setPreview(null);
    setPreviewDefinition(null);
    setError('');
    setNotice(`${preset.label} preset loaded. Preview to refresh the data.`);
  }

  const chart =
    preview && previewDefinition
      ? previewChart(preview, previewDefinition)
      : null;

  if (loading) return <p role="status">Loading report datasets…</p>;
  return (
    <main className="report-builder">
      <header className="report-builder__header">
        <div>
          <p className="report-builder__eyebrow">REPORTING</p>
          <h1>Reports</h1>
          <p>
            Build organization reports from the records your role can access.
          </p>
        </div>
        <Button
          type="button"
          secondary
          onClick={() => void load()}
          disabled={busy}
        >
          Refresh
        </Button>
      </header>

      {error && (
        <p className="report-builder__message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p
          className="report-builder__message report-builder__message--success"
          role="status"
        >
          {notice}
        </p>
      )}

      <div className="report-builder__layout">
        <aside className="report-builder__saved" aria-label="Saved reports">
          <Card>
            <h2>Saved reports</h2>
            {savedReports.length === 0 ? (
              <p>No reports saved yet.</p>
            ) : (
              <ul>
                {savedReports.map((report) => (
                  <li key={report.id}>
                    <button
                      className="report-builder__saved-link"
                      type="button"
                      aria-current={
                        selectedReport?.id === report.id ? 'true' : undefined
                      }
                      onClick={() => {
                        loadSavedReport(report);
                      }}
                    >
                      <strong>{report.name}</strong>
                      <small>
                        {datasets.find(
                          (item) => item.key === report.definition.dataset,
                        )?.label ?? report.definition.dataset}
                      </small>
                    </button>
                    <button
                      type="button"
                      className="report-builder__text-button"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        void download(
                          `${base}/saved-reports/${encodeURIComponent(report.id)}/export?format=csv`,
                          'GET',
                        )
                          .then(() => {
                            setNotice('CSV export downloaded.');
                          })
                          .catch((caught: unknown) => {
                            setError(
                              caught instanceof Error
                                ? caught.message
                                : 'Export failed.',
                            );
                          })
                          .finally(() => {
                            setBusy(false);
                          });
                      }}
                    >
                      Export CSV
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button
              type="button"
              secondary
              onClick={() => {
                setSelectedReport(null);
                setReportName('');
                setSharedRoles([]);
                if (datasets[0]) chooseDataset(datasets[0].key);
              }}
            >
              New report
            </Button>
          </Card>
        </aside>

        <section className="report-builder__main" aria-label="Report editor">
          <Card className="report-builder__editor">
            <h2>Build a report</h2>
            <section
              className="report-builder__presets"
              aria-labelledby="report-presets-title"
            >
              <h3 id="report-presets-title">Standard reports</h3>
              <div>
                {reportPresets
                  .filter((preset) => {
                    const source = datasets.find(
                      (item) => item.key === preset.dataset,
                    );
                    if (!source?.available) return false;
                    const available = new Set(
                      source.columns.map((column) => column.key),
                    );
                    return (
                      preset.columns.every((key) => available.has(key)) &&
                      preset.groupBy.every((key) => available.has(key)) &&
                      (preset.filters ?? []).every((filter) =>
                        available.has(filter.column),
                      ) &&
                      (!preset.aggregate ||
                        (preset.aggregate.fn === 'count' &&
                        preset.aggregate.column === 'id'
                          ? true
                          : available.has(preset.aggregate.column)))
                    );
                  })
                  .map((preset) => (
                    <Button
                      key={preset.label}
                      type="button"
                      secondary
                      onClick={() => {
                        applyPreset(preset);
                      }}
                    >
                      {preset.label}
                    </Button>
                  ))}
              </div>
            </section>
            {datasets.length === 0 ? (
              <p>No report datasets are currently available to your role.</p>
            ) : (
              <>
                <div className="report-builder__fields">
                  <Field label="Dataset">
                    <Select
                      aria-label="Dataset"
                      value={datasetKey}
                      options={datasets.map((item) => ({
                        value: item.key,
                        label: item.label,
                      }))}
                      onChange={(event) => {
                        chooseDataset(event.target.value);
                      }}
                    />
                  </Field>
                  <Field label="Report name">
                    <Input
                      value={reportName}
                      maxLength={200}
                      onChange={(event) => {
                        setReportName(event.target.value);
                      }}
                      placeholder="For example, registrations by program"
                    />
                  </Field>
                </div>

                {dataset && (
                  <>
                    {dataset.key === 'retention_cohorts' && (
                      <p className="report-builder__muted">
                        Retention compares unique confirmed participants in
                        adjacent calendar years. This cohort report keeps its
                        defined comparison and supports saving, sharing,
                        scheduling and export.
                      </p>
                    )}
                    <fieldset className="report-builder__fieldset">
                      <legend>Columns</legend>
                      <div className="report-builder__column-list">
                        {dataset.columns.map((column) => (
                          <label
                            className="report-builder__column"
                            key={column.key}
                          >
                            <Checkbox
                              checked={columns.includes(column.key)}
                              onChange={(event) => {
                                setColumns((current) =>
                                  event.target.checked
                                    ? [...current, column.key]
                                    : current.filter(
                                        (key) => key !== column.key,
                                      ),
                                );
                              }}
                            />
                            <span>{column.label}</span>
                            <small>{tierName(column.tier)}</small>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <section
                      className="report-builder__subsection"
                      aria-labelledby="report-filters-title"
                    >
                      <div className="report-builder__section-heading">
                        <h3 id="report-filters-title">Filters</h3>
                        <Button
                          type="button"
                          secondary
                          disabled={dataset.key === 'retention_cohorts'}
                          onClick={addFilter}
                        >
                          Add filter
                        </Button>
                      </div>
                      {filters.length === 0 && (
                        <p>
                          No filters. The report includes all matching records.
                        </p>
                      )}
                      {filters.map((filter, index) => {
                        const field =
                          columnByKey.get(filter.column) ?? dataset.columns[0];
                        return (
                          <div
                            className="report-builder__filter"
                            key={`${filter.column}-${String(index)}`}
                          >
                            <Select
                              aria-label={`Filter ${String(index + 1)} column`}
                              value={filter.column}
                              options={dataset.columns.map((column) => ({
                                value: column.key,
                                label: column.label,
                              }))}
                              onChange={(event) => {
                                setFilters((current) =>
                                  current.map((item, i) =>
                                    i === index
                                      ? { ...item, column: event.target.value }
                                      : item,
                                  ),
                                );
                              }}
                            />
                            <Select
                              aria-label={`Filter ${String(index + 1)} condition`}
                              value={filter.op}
                              options={filterOperators.map((option) => ({
                                ...option,
                              }))}
                              onChange={(event) => {
                                setFilters((current) =>
                                  current.map((item, i) =>
                                    i === index
                                      ? {
                                          ...item,
                                          op: event.target
                                            .value as ReportFilter['op'],
                                        }
                                      : item,
                                  ),
                                );
                              }}
                            />
                            {filter.op !== 'is_null' &&
                              filter.op !== 'not_null' &&
                              (field?.type === 'boolean' ? (
                                <Select
                                  aria-label={`Filter ${String(index + 1)} value`}
                                  value={String(filter.value ?? 'true')}
                                  options={[
                                    { value: 'true', label: 'Yes' },
                                    { value: 'false', label: 'No' },
                                  ]}
                                  onChange={(event) => {
                                    setFilters((current) =>
                                      current.map((item, i) =>
                                        i === index
                                          ? {
                                              ...item,
                                              value: event.target.value,
                                            }
                                          : item,
                                      ),
                                    );
                                  }}
                                />
                              ) : (
                                <Input
                                  aria-label={`Filter ${String(index + 1)} value`}
                                  type={
                                    field?.type === 'date'
                                      ? 'date'
                                      : field?.type === 'number' ||
                                          field?.type === 'money'
                                        ? 'number'
                                        : 'text'
                                  }
                                  value={
                                    Array.isArray(filter.value)
                                      ? filter.value.join('|')
                                      : String(filter.value ?? '')
                                  }
                                  placeholder={
                                    filter.op === 'between'
                                      ? 'First value | second value'
                                      : 'Value'
                                  }
                                  onChange={(event) => {
                                    setFilters((current) =>
                                      current.map((item, i) =>
                                        i === index
                                          ? {
                                              ...item,
                                              value: event.target.value,
                                            }
                                          : item,
                                      ),
                                    );
                                  }}
                                />
                              ))}
                            <Button
                              type="button"
                              secondary
                              onClick={() => {
                                setFilters((current) =>
                                  current.filter((_, i) => i !== index),
                                );
                              }}
                            >
                              Remove
                            </Button>
                          </div>
                        );
                      })}
                    </section>

                    <div className="report-builder__fields">
                      <Field label="Group by">
                        <Select
                          aria-label="Group by"
                          disabled={dataset.key === 'retention_cohorts'}
                          value={groupBy[0] ?? ''}
                          options={[
                            { value: '', label: 'No grouping' },
                            ...dataset.columns.map((column) => ({
                              value: column.key,
                              label: column.label,
                            })),
                          ]}
                          onChange={(event) => {
                            chooseGroup(event.target.value);
                          }}
                        />
                      </Field>
                      {['date', 'datetime'].includes(
                        columnByKey.get(groupBy[0] ?? '')?.type ?? '',
                      ) && (
                        <Field label="Time period">
                          <Select
                            aria-label="Time period"
                            value={timeGrain}
                            options={[
                              { value: '', label: 'Exact date and time' },
                              { value: 'day', label: 'Day' },
                              { value: 'week', label: 'Week' },
                              { value: 'month', label: 'Month' },
                              { value: 'year', label: 'Year' },
                            ]}
                            onChange={(event) => {
                              setTimeGrain(
                                event.target.value as TimeGrain | '',
                              );
                            }}
                          />
                        </Field>
                      )}
                      <Field label="Aggregate">
                        <Select
                          aria-label="Aggregate function"
                          disabled={dataset.key === 'retention_cohorts'}
                          value={aggregate}
                          options={[
                            { value: '', label: 'No aggregate' },
                            ...aggregateOptions.map((option) => ({
                              ...option,
                            })),
                          ]}
                          onChange={(event) => {
                            setAggregate(event.target.value);
                          }}
                        />
                      </Field>
                      {aggregate && (
                        <Field label="Aggregate column">
                          <Select
                            aria-label="Aggregate column"
                            value={aggregateColumn}
                            options={(aggregate === 'count'
                              ? dataset.columns
                              : numericColumns
                            ).map((column) => ({
                              value: column.key,
                              label: column.label,
                            }))}
                            onChange={(event) => {
                              setAggregateColumn(event.target.value);
                            }}
                          />
                        </Field>
                      )}
                      <Field label="Sort by">
                        <Select
                          aria-label="Sort by"
                          value={sortColumn}
                          options={[
                            { value: '', label: 'No sorting' },
                            ...dataset.columns.map((column) => ({
                              value: column.key,
                              label: column.label,
                            })),
                          ]}
                          onChange={(event) => {
                            setSortColumn(event.target.value);
                          }}
                        />
                      </Field>
                      {sortColumn && (
                        <Field label="Direction">
                          <Select
                            aria-label="Sort direction"
                            value={sortDirection}
                            options={[
                              { value: 'asc', label: 'Ascending' },
                              { value: 'desc', label: 'Descending' },
                            ]}
                            onChange={(event) => {
                              setSortDirection(
                                event.target.value as 'asc' | 'desc',
                              );
                            }}
                          />
                        </Field>
                      )}
                    </div>

                    <div className="report-builder__actions">
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={() => void runPreview()}
                      >
                        Preview report
                      </Button>
                      <Button
                        type="button"
                        secondary
                        disabled={busy}
                        onClick={() => void exportCurrent('csv')}
                      >
                        Export CSV
                      </Button>
                      <Button
                        type="button"
                        secondary
                        disabled={busy}
                        onClick={() => void exportCurrent('xlsx')}
                      >
                        Export XLSX
                      </Button>
                      <Button
                        type="button"
                        secondary
                        disabled={busy || !reportName.trim()}
                        onClick={() => void saveReport()}
                      >
                        {selectedReport ? 'Update saved report' : 'Save report'}
                      </Button>
                    </div>

                    <fieldset className="report-builder__fieldset">
                      <legend>Share with roles</legend>
                      <div className="report-builder__role-list">
                        {orgRoleSchema.options.map((role) => (
                          <label key={role}>
                            <Checkbox
                              checked={sharedRoles.includes(role)}
                              onChange={(event) => {
                                setSharedRoles((current) =>
                                  event.target.checked
                                    ? [...current, role]
                                    : current.filter((item) => item !== role),
                                );
                              }}
                            />
                            {role.replaceAll('_', ' ')}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </>
                )}
              </>
            )}
          </Card>

          {preview && (
            <Card className="report-builder__preview">
              <header className="report-builder__section-heading">
                <div>
                  <h2>Preview</h2>
                  <p>{preview.rows.length} rows shown, up to 200.</p>
                </div>
                {preview.truncated && (
                  <span className="report-builder__muted">
                    Preview limited to 200 rows.
                  </span>
                )}
              </header>
              {chart && chart.data.length > 0 && (
                <figure
                  className="report-builder__chart"
                  role="img"
                  aria-label={`${chart.aggregate} by ${chart.label}`}
                >
                  <figcaption>
                    {chart.aggregate} by {chart.label}
                  </figcaption>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={chart.data} accessibilityLayer>
                      <XAxis dataKey="label" tickFormatter={chartLabel} />
                      <YAxis />
                      <Tooltip />
                      <Bar dataKey="value" fill="var(--accent)" />
                    </BarChart>
                  </ResponsiveContainer>
                </figure>
              )}
              <div className="report-builder__table-wrap">
                <table className="report-builder__table">
                  <thead>
                    <tr>
                      {preview.columns.map((column) => (
                        <th key={column.key}>{column.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, rowIndex) => (
                      <tr
                        key={`${JSON.stringify(row[0] ?? 'row')}-${String(rowIndex)}`}
                      >
                        {preview.columns.map((column, columnIndex) => (
                          <td key={column.key}>
                            {displayValue(
                              row[columnIndex],
                              columnByKey.get(column.key),
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.rows.length === 0 && (
                <p>No records match this report.</p>
              )}
            </Card>
          )}

          <Card className="report-builder__schedule">
            <h2>Scheduled delivery</h2>
            <p>
              Deliver a sign-in protected link to your verified organization
              account.
            </p>
            <div className="report-builder__schedule-controls">
              <Field label="Cadence">
                <Select
                  aria-label="Schedule cadence"
                  value={cadence}
                  options={[
                    { value: 'daily', label: 'Daily' },
                    { value: 'weekly', label: 'Weekly' },
                    { value: 'monthly', label: 'Monthly' },
                  ]}
                  onChange={(event) => {
                    setCadence(
                      event.target.value as 'daily' | 'weekly' | 'monthly',
                    );
                  }}
                />
              </Field>
              <Field label="Organization local time">
                <Input
                  aria-label="Scheduled local time"
                  type="time"
                  value={runAt}
                  onChange={(event) => {
                    setRunAt(event.target.value);
                  }}
                />
              </Field>
              <Button
                type="button"
                disabled={busy || !selectedReport || !account}
                onClick={() => void scheduleReport()}
              >
                Schedule report
              </Button>
            </div>
            {schedules.length > 0 && (
              <div className="report-builder__table-wrap">
                <table className="report-builder__table">
                  <thead>
                    <tr>
                      <th>Report</th>
                      <th>Cadence</th>
                      <th>Next delivery</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedules.map((schedule) => (
                      <tr key={schedule.id}>
                        <td>
                          {savedReports.find(
                            (item) => item.id === schedule.savedReportId,
                          )?.name ?? 'Saved report'}
                        </td>
                        <td>{schedule.cadence}</td>
                        <td>
                          <time dateTime={schedule.nextRunAt}>
                            {new Date(schedule.nextRunAt).toLocaleString()}
                          </time>
                        </td>
                        <td>{schedule.status}</td>
                        <td>
                          <Button
                            type="button"
                            secondary
                            disabled={busy}
                            onClick={() => void toggleSchedule(schedule)}
                          >
                            {schedule.status === 'active' ? 'Pause' : 'Resume'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>
      </div>
    </main>
  );
}
