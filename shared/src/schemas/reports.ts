import { z } from 'zod';

const columnKey = z.string().regex(/^[a-z0-9_]{1,60}$/, 'Invalid column key');

export const reportFilterSchema = z.strictObject({
  column: columnKey,
  op: z.enum([
    'eq',
    'ne',
    'lt',
    'lte',
    'gt',
    'gte',
    'contains',
    'starts_with',
    'in',
    'between',
    'is_null',
    'not_null',
  ]),
  value: z
    .union([
      z.string().max(500),
      z.number(),
      z.boolean(),
      z
        .array(z.union([z.string().max(500), z.number()]))
        .min(1)
        .max(200),
    ])
    .optional(),
});

export const reportAggregateSchema = z.strictObject({
  fn: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  column: columnKey,
});

export const reportSortSchema = z.strictObject({
  column: columnKey,
  direction: z.enum(['asc', 'desc']),
});

export const reportDefinitionSchema = z.strictObject({
  dataset: z.string().regex(/^[a-z0-9_]{1,60}$/),
  columns: z.array(columnKey).min(1).max(80),
  filters: z.array(reportFilterSchema).max(40).default([]),
  groupBy: z.array(columnKey).max(8).default([]),
  aggregates: z.array(reportAggregateSchema).max(20).default([]),
  sort: z.array(reportSortSchema).max(8).default([]),
  limit: z.number().int().min(1).max(50_000).optional(),
});

export type ReportFilter = z.infer<typeof reportFilterSchema>;
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

export const savedReportBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  definition: reportDefinitionSchema,
  sharedRoles: z
    .array(z.string().regex(/^[a-z_]{1,40}$/))
    .max(20)
    .default([]),
});

export const savedReportUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  definition: reportDefinitionSchema.optional(),
  sharedRoles: z
    .array(z.string().regex(/^[a-z_]{1,40}$/))
    .max(20)
    .optional(),
  expectedVersion: z.number().int().positive(),
});

export const reportScheduleBodySchema = z.strictObject({
  savedReportId: z.uuid(),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  recipientAccountIds: z.array(z.uuid()).min(1).max(20),
  delivery: z.enum(['link', 'csv_attachment']),
  format: z.enum(['csv', 'xlsx']).default('csv'),
  /** Minutes after midnight in the organization's timezone. */
  runAtMinute: z.number().int().min(0).max(1439).default(360),
});

export const reportScheduleUpdateSchema = z.strictObject({
  cadence: z.enum(['daily', 'weekly', 'monthly']).optional(),
  recipientAccountIds: z.array(z.uuid()).min(1).max(20).optional(),
  delivery: z.enum(['link', 'csv_attachment']).optional(),
  format: z.enum(['csv', 'xlsx']).optional(),
  runAtMinute: z.number().int().min(0).max(1439).optional(),
  status: z.enum(['active', 'paused']).optional(),
  expectedVersion: z.number().int().positive(),
});

export const reportExportQuerySchema = z.strictObject({
  format: z.enum(['csv', 'xlsx']).default('csv'),
});

export const reportPreviewBodySchema = z.strictObject({
  definition: reportDefinitionSchema,
});

export const reportDatasetColumnSchema = z.strictObject({
  key: columnKey,
  label: z.string(),
  type: z.enum([
    'text',
    'number',
    'money',
    'date',
    'datetime',
    'boolean',
    'enum',
  ]),
  tier: z.enum(['public', 'internal', 'sensitive', 'restricted']),
});

export const reportDatasetSchema = z.strictObject({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  available: z.boolean(),
  columns: z.array(reportDatasetColumnSchema),
});

export const reportDatasetListSchema = z.strictObject({
  items: z.array(reportDatasetSchema),
});

export const reportPreviewResponseSchema = z.strictObject({
  columns: z.array(
    z.strictObject({ key: columnKey, label: z.string(), type: z.string() }),
  ),
  rows: z.array(z.array(z.unknown())),
  truncated: z.boolean(),
});

export const savedReportResponseSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  definition: reportDefinitionSchema,
  sharedRoles: z.array(z.string()),
  isPreset: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const savedReportListSchema = z.strictObject({
  items: z.array(savedReportResponseSchema),
});

export const savedReportCreateResponseSchema = z.strictObject({
  report: savedReportResponseSchema,
});
