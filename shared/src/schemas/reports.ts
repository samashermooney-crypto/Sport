import { z } from 'zod';

const columnKey = z
  .string()
  .regex(/^[a-z0-9_]{1,60}$/, 'Invalid column key');

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
      z.number().finite(),
      z.boolean(),
      z.array(z.union([z.string().max(500), z.number().finite()])).min(1).max(200),
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
  sharedRoles: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(20).default([]),
});

export const savedReportUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  definition: reportDefinitionSchema.optional(),
  sharedRoles: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(20).optional(),
  expectedVersion: z.number().int().positive(),
});

export const reportScheduleBodySchema = z.strictObject({
  savedReportId: z.uuid(),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  recipients: z.array(z.email()).min(1).max(20),
  delivery: z.enum(['link', 'csv_attachment']),
  format: z.enum(['csv', 'xlsx']).default('csv'),
  /** Minutes after UTC midnight when the schedule fires. */
  runAtMinute: z.number().int().min(0).max(1439).default(360),
});

export const reportScheduleUpdateSchema = z.strictObject({
  cadence: z.enum(['daily', 'weekly', 'monthly']).optional(),
  recipients: z.array(z.email()).min(1).max(20).optional(),
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
