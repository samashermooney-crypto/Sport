import { inflateSync } from 'node:zlib';

import * as fontkit from '@pdf-lib/fontkit';
import { reportDefinitionSchema } from '@shared/schemas/reports';
import type { ReportDefinition } from '@shared/schemas/reports';
import { PDFDocument, rgb } from 'pdf-lib';

import type { OrgContext } from '../../db/withOrg';
import { withOrg } from '../../db/withOrg';
import { openSansRegularDeflatedBase64 } from '../finance/open-sans-font';

import { exportReport, listReportDatasets } from './service';

type BoardMetric = {
  key: string;
  label: string;
  display: string;
};

type MetricSpec = {
  key: string;
  label: string;
  dataset: string;
  definition: ReportDefinition;
  aggregateKeys: readonly string[];
  format: 'count' | 'money' | 'forecast' | 'compliance';
};

const definition = (value: unknown): ReportDefinition =>
  reportDefinitionSchema.parse(value);

function metricSpecs(now: Date): readonly MetricSpec[] {
  const yearStart = new Date(now);
  yearStart.setUTCFullYear(yearStart.getUTCFullYear() - 1);
  const forecastEnd = new Date(now);
  forecastEnd.setUTCDate(forecastEnd.getUTCDate() + 90);
  const startDate = yearStart.toISOString();
  const today = now.toISOString().slice(0, 10);
  const forecastDate = forecastEnd.toISOString().slice(0, 10);

  return [
    {
      key: 'registrations',
      label: 'Registrations · past 12 months',
      dataset: 'registrations',
      definition: definition({
        dataset: 'registrations',
        columns: ['id'],
        filters: [{ column: 'created_at', op: 'gte', value: startDate }],
        groupBy: [],
        aggregates: [{ fn: 'count', column: 'id' }],
        sort: [],
      }),
      aggregateKeys: ['count_id'],
      format: 'count',
    },
    {
      key: 'gross-invoiced',
      label: 'Gross invoiced · past 12 months',
      dataset: 'invoices',
      definition: definition({
        dataset: 'invoices',
        columns: ['total_cents'],
        filters: [
          { column: 'issued_at', op: 'gte', value: startDate },
          { column: 'status', op: 'ne', value: 'void' },
        ],
        groupBy: [],
        aggregates: [{ fn: 'sum', column: 'total_cents' }],
        sort: [],
      }),
      aggregateKeys: ['sum_total_cents'],
      format: 'money',
    },
    {
      key: 'net-receipts',
      label: 'Net payments after fees · past 12 months',
      dataset: 'payments',
      definition: definition({
        dataset: 'payments',
        columns: ['net_cents'],
        filters: [
          { column: 'succeeded_at', op: 'gte', value: startDate },
          { column: 'status', op: 'eq', value: 'succeeded' },
        ],
        groupBy: [],
        aggregates: [{ fn: 'sum', column: 'net_cents' }],
        sort: [],
      }),
      aggregateKeys: ['sum_net_cents'],
      format: 'money',
    },
    {
      key: 'processing-fees',
      label: 'Processing fees · past 12 months',
      dataset: 'payments',
      definition: definition({
        dataset: 'payments',
        columns: ['processing_fee_cents'],
        filters: [
          { column: 'succeeded_at', op: 'gte', value: startDate },
          { column: 'status', op: 'eq', value: 'succeeded' },
        ],
        groupBy: [],
        aggregates: [{ fn: 'sum', column: 'processing_fee_cents' }],
        sort: [],
      }),
      aggregateKeys: ['sum_processing_fee_cents'],
      format: 'money',
    },
    {
      key: 'refunds',
      label: 'Refunds · past 12 months',
      dataset: 'refunds',
      definition: definition({
        dataset: 'refunds',
        columns: ['amount_cents'],
        filters: [
          { column: 'succeeded_at', op: 'gte', value: startDate },
          { column: 'status', op: 'eq', value: 'succeeded' },
        ],
        groupBy: [],
        aggregates: [{ fn: 'sum', column: 'amount_cents' }],
        sort: [],
      }),
      aggregateKeys: ['sum_amount_cents'],
      format: 'money',
    },
    {
      key: 'disputes',
      label: 'Amounts in dispute',
      dataset: 'invoices',
      definition: definition({
        dataset: 'invoices',
        columns: ['disputed_cents'],
        filters: [{ column: 'disputed_cents', op: 'gt', value: 0 }],
        groupBy: [],
        aggregates: [{ fn: 'sum', column: 'disputed_cents' }],
        sort: [],
      }),
      aggregateKeys: ['sum_disputed_cents'],
      format: 'money',
    },
    {
      key: 'outstanding',
      label: 'Outstanding balances',
      dataset: 'invoices',
      definition: definition({
        dataset: 'invoices',
        columns: ['balance_cents'],
        filters: [{ column: 'balance_cents', op: 'gt', value: 0 }],
        groupBy: [],
        aggregates: [{ fn: 'sum', column: 'balance_cents' }],
        sort: [],
      }),
      aggregateKeys: ['sum_balance_cents'],
      format: 'money',
    },
    {
      key: 'installment-forecast',
      label: 'Installments due · next 90 days',
      dataset: 'installments',
      definition: definition({
        dataset: 'installments',
        columns: ['amount_cents', 'paid_cents'],
        filters: [
          { column: 'due_on', op: 'gte', value: today },
          { column: 'due_on', op: 'lte', value: forecastDate },
          { column: 'status', op: 'ne', value: 'canceled' },
          { column: 'status', op: 'ne', value: 'paid' },
        ],
        groupBy: [],
        aggregates: [
          { fn: 'sum', column: 'amount_cents' },
          { fn: 'sum', column: 'paid_cents' },
        ],
        sort: [],
      }),
      aggregateKeys: ['sum_amount_cents', 'sum_paid_cents'],
      format: 'forecast',
    },
    {
      key: 'credential-compliance',
      label: 'Compliant credential share',
      dataset: 'credentials',
      definition: definition({
        dataset: 'credentials',
        columns: ['compliance_status'],
        filters: [{ column: 'status', op: 'ne', value: 'revoked' }],
        groupBy: ['compliance_status'],
        aggregates: [{ fn: 'count', column: 'id' }],
        sort: [{ column: 'compliance_status', direction: 'asc' }],
        limit: 20,
      }),
      aggregateKeys: ['compliance_status', 'count_id'],
      format: 'compliance',
    },
  ];
}

function numericValue(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function metricValue(
  spec: MetricSpec,
  result: {
    columns: { key: string }[];
    rows: unknown[][];
  },
): number | null {
  if (spec.format === 'compliance') {
    const statusIndex = result.columns.findIndex(
      ({ key }) => key === spec.aggregateKeys[0],
    );
    const countIndex = result.columns.findIndex(
      ({ key }) => key === spec.aggregateKeys[1],
    );
    if (statusIndex < 0 || countIndex < 0) return null;
    const counts = result.rows.flatMap((row) => {
      const value = numericValue(row[countIndex]);
      return typeof row[statusIndex] === 'string' && value !== null
        ? [{ status: row[statusIndex], value }]
        : [];
    });
    const total = counts.reduce((sum, item) => sum + item.value, 0);
    if (total === 0) return null;
    const verified =
      counts.find((item) => item.status === 'verified')?.value ?? 0;
    return (verified / total) * 100;
  }

  const values = spec.aggregateKeys.map((key) => {
    const index = result.columns.findIndex((column) => column.key === key);
    return index < 0 ? null : numericValue(result.rows[0]?.[index]);
  });
  if (values.some((value) => value === null)) return null;
  if (spec.format === 'forecast')
    return Math.max(0, (values[0] ?? 0) - (values[1] ?? 0));
  return values[0] ?? null;
}

function formattedValue(spec: MetricSpec, value: number): string {
  if (spec.format === 'money' || spec.format === 'forecast')
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(value / 100);
  if (spec.format === 'compliance') return `${value.toFixed(1)}%`;
  return new Intl.NumberFormat('en-US').format(value);
}

async function loadMetrics(
  context: OrgContext,
  now: Date,
  stepUpAuthenticated: boolean,
  withOrgExecutor: typeof withOrg,
): Promise<BoardMetric[]> {
  const datasets = await listReportDatasets(context, withOrgExecutor);
  const metrics: BoardMetric[] = [];
  for (const spec of metricSpecs(now)) {
    const dataset = datasets.items.find((item) => item.key === spec.dataset);
    if (!dataset?.available) continue;
    const visible = new Set(dataset.columns.map(({ key }) => key));
    const required = new Set([
      ...spec.definition.columns,
      ...spec.definition.filters.map(({ column }) => column),
      ...spec.definition.groupBy,
      ...spec.definition.aggregates.map(({ column }) => column),
    ]);
    if (![...required].every((key) => visible.has(key))) continue;
    const result = await exportReport(
      context,
      spec.definition,
      stepUpAuthenticated,
      withOrgExecutor,
    );
    const value = metricValue(spec, result);
    if (value === null) continue;
    metrics.push({
      key: spec.key,
      label: spec.label,
      display: formattedValue(spec, value),
    });
  }
  return metrics;
}

function supportedText(
  value: string,
  font: ReturnType<typeof fontkit.create>,
): string {
  return Array.from(value)
    .map((character) => {
      const point = character.codePointAt(0);
      if (point === undefined) return '?';
      if (point <= 31 || (point >= 127 && point <= 159)) return ' ';
      return font.hasGlyphForCodePoint(point) ? character : '?';
    })
    .join('');
}

function createPdf(
  orgName: string,
  metrics: readonly BoardMetric[],
  now: Date,
): Promise<Uint8Array> {
  return (async () => {
    const document = await PDFDocument.create();
    document.setTitle('Board season summary');
    document.setSubject('Aggregate organization season summary');
    const fontBytes = inflateSync(
      Buffer.from(openSansRegularDeflatedBase64, 'base64'),
    );
    const glyphFont = fontkit.create(fontBytes);
    document.registerFontkit(fontkit);
    const font = await document.embedFont(fontBytes, { subset: true });
    const page = document.addPage([612, 792]);
    const accent = rgb(58 / 255, 103 / 255, 178 / 255);
    const ink = rgb(21 / 255, 24 / 255, 28 / 255);
    const muted = rgb(83 / 255, 94 / 255, 107 / 255);
    const border = rgb(199 / 255, 208 / 255, 213 / 255);
    const draw = (
      text: string,
      x: number,
      y: number,
      size: number,
      color = ink,
    ) => {
      page.drawText(supportedText(text, glyphFont), {
        x,
        y,
        size,
        font,
        color,
      });
    };

    page.drawRectangle({ x: 0, y: 760, width: 612, height: 32, color: accent });
    draw('BOARD SEASON SUMMARY', 42, 771, 10, rgb(1, 1, 1));
    draw(orgName.slice(0, 72), 42, 718, 24);
    draw(
      `Prepared ${new Intl.DateTimeFormat('en-US', {
        dateStyle: 'long',
        timeZone: 'UTC',
      }).format(now)} · Aggregate reporting only`,
      42,
      694,
      10,
      muted,
    );
    page.drawLine({
      start: { x: 42, y: 676 },
      end: { x: 570, y: 676 },
      thickness: 1,
      color: border,
    });

    const cardWidth = 168;
    const cardHeight = 104;
    const gapX = 12;
    const gapY = 14;
    const startX = 42;
    const startY = 642;
    for (const [index, metric] of metrics.slice(0, 9).entries()) {
      const column = index % 3;
      const row = Math.floor(index / 3);
      const x = startX + column * (cardWidth + gapX);
      const y = startY - row * (cardHeight + gapY) - cardHeight;
      page.drawRectangle({
        x,
        y,
        width: cardWidth,
        height: cardHeight,
        borderColor: border,
        borderWidth: 0.8,
        color: rgb(1, 1, 1),
      });
      draw(metric.label, x + 12, y + 73, 9, muted);
      draw(metric.display, x + 12, y + 39, 18, ink);
    }

    const footerY = 76;
    page.drawLine({
      start: { x: 42, y: footerY + 14 },
      end: { x: 570, y: footerY + 14 },
      thickness: 0.8,
      color: border,
    });
    draw(
      metrics.length === 0
        ? 'No report metrics are available for this account role.'
        : 'Financial totals are subject to the organization report access policy.',
      42,
      footerY,
      8,
      muted,
    );
    return document.save();
  })();
}

export async function buildBoardSeasonReportPdf(
  context: OrgContext,
  options: { stepUpAuthenticated: boolean; now?: Date },
  withOrgExecutor: typeof withOrg = withOrg,
): Promise<Uint8Array> {
  const now = options.now ?? new Date();
  const [organization, metrics] = await Promise.all([
    withOrgExecutor(context, (trx) =>
      trx
        .selectFrom('organizations')
        .select('name')
        .where('id', '=', context.orgId)
        .executeTakeFirstOrThrow(),
    ),
    loadMetrics(context, now, options.stepUpAuthenticated, withOrgExecutor),
  ]);
  return createPdf(organization.name, metrics, now);
}

export { createPdf as renderBoardSeasonSummaryPdf };
