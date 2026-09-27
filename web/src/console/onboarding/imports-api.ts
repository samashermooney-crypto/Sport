import { z } from 'zod';

export const importKindSchema = z.enum([
  'people',
  'households',
  'registrations',
  'teams',
  'rosters',
  'schedule',
  'facilities',
  'credentials',
  'historical_payments',
  'volunteer_hours',
]);
export type ImportKind = z.infer<typeof importKindSchema>;

export const importMappingSchema = z.strictObject({
  columns: z.record(z.string(), z.string().nullable()),
  options: z
    .object({
      duplicateStrategy: z.enum(['ask', 'skip_all']).optional(),
      defaultStatus: z.string().optional(),
    })
    .optional(),
});

export const importBatchSchema = z.strictObject({
  id: z.uuid(),
  orgId: z.uuid(),
  kind: importKindSchema,
  fileName: z.string(),
  fileBytes: z.number(),
  headers: z.array(z.string()),
  sampleRows: z.array(z.record(z.string(), z.string())),
  mapping: importMappingSchema.nullable(),
  mappingPresetId: z.uuid().nullable(),
  status: z.enum([
    'uploaded',
    'mapped',
    'validating',
    'validated',
    'committing',
    'committed',
    'failed',
    'rolled_back',
  ]),
  rowCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  progress: z.strictObject({
    processed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  summary: z.record(z.string(), z.unknown()).nullable(),
  createdBy: z.uuid(),
  committedAt: z.iso.datetime().nullable(),
  rolledBackAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

export const importBatchListSchema = z.strictObject({
  items: z.array(importBatchSchema),
});
export const importFieldsSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      kind: importKindSchema,
      fields: z.array(
        z.strictObject({
          key: z.string(),
          label: z.string(),
          required: z.boolean(),
          aliases: z.array(z.string()),
        }),
      ),
    }),
  ),
});
export const importRowsSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.uuid(),
      rowNumber: z.number().int().positive(),
      raw: z.record(z.string(), z.string()),
      normalized: z.record(z.string(), z.unknown()).nullable(),
      issues: z.array(
        z.strictObject({
          level: z.enum(['error', 'warning']),
          code: z.string(),
          message: z.string(),
          field: z.string().optional(),
        }),
      ),
      duplicates: z.array(
        z.strictObject({
          personId: z.uuid(),
          name: z.string(),
          reasons: z.array(z.string()),
        }),
      ),
      action: z.enum(['create', 'update', 'merge', 'skip']),
      targetId: z.uuid().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export const importPresetListSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.uuid(),
      orgId: z.uuid().nullable(),
      kind: importKindSchema,
      name: z.string(),
      mapping: importMappingSchema,
      builtin: z.boolean(),
    }),
  ),
});
