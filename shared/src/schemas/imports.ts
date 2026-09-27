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

export const importBatchStatusSchema = z.enum([
  'uploaded',
  'mapped',
  'validating',
  'validated',
  'committing',
  'committed',
  'failed',
  'rolled_back',
]);

export const importIssueSchema = z.strictObject({
  level: z.enum(['error', 'warning']),
  field: z.string().optional(),
  code: z.string(),
  message: z.string(),
});
export type ImportIssue = z.infer<typeof importIssueSchema>;

export const importDuplicateSchema = z.strictObject({
  personId: z.uuid(),
  name: z.string(),
  reasons: z.array(z.string()),
});
export type ImportDuplicate = z.infer<typeof importDuplicateSchema>;

export const importRowActionSchema = z.enum([
  'create',
  'update',
  'merge',
  'skip',
]);

export const importMappingSchema = z.strictObject({
  columns: z.record(z.string(), z.string().nullable()),
  options: z
    .strictObject({
      duplicateStrategy: z.enum(['ask', 'skip_all', 'update_all']).optional(),
      defaultStatus: z.string().optional(),
    })
    .optional(),
});
export type ImportMapping = z.infer<typeof importMappingSchema>;

export const importFieldSchema = z.strictObject({
  key: z.string(),
  label: z.string(),
  type: z.enum([
    'text',
    'email',
    'phone',
    'date',
    'datetime',
    'time',
    'int',
    'money',
    'bool',
    'enum',
    'gender',
    'list',
    'address',
  ]),
  required: z.boolean(),
  enum: z.array(z.string()).optional(),
  description: z.string(),
  aliases: z.array(z.string()),
});
export type ImportField = z.infer<typeof importFieldSchema>;

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
  status: importBatchStatusSchema,
  rowCount: z.number(),
  errorCount: z.number(),
  progress: z.strictObject({ processed: z.number(), total: z.number() }),
  summary: z.record(z.string(), z.unknown()).nullable(),
  createdBy: z.uuid(),
  committedAt: z.string().nullable(),
  rolledBackAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

export const importBatchListSchema = z.strictObject({
  items: z.array(importBatchSchema.omit({ headers: true, sampleRows: true })),
});

export const importRowSchema = z.strictObject({
  id: z.uuid(),
  rowNumber: z.number(),
  raw: z.record(z.string(), z.string()),
  normalized: z.record(z.string(), z.unknown()).nullable(),
  issues: z.array(importIssueSchema),
  duplicates: z.array(importDuplicateSchema),
  action: importRowActionSchema,
  targetId: z.uuid().nullable(),
});
export type ImportRow = z.infer<typeof importRowSchema>;

export const importRowListSchema = z.strictObject({
  items: z.array(importRowSchema),
  nextCursor: z.string().nullable(),
});

export const importRowsQuerySchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  filter: z.enum(['all', 'errors', 'duplicates']).default('all'),
});

export const setMappingBodySchema = z.strictObject({
  mapping: importMappingSchema,
  savePresetAs: z.string().min(1).max(120).optional(),
});

export const decideRowBodySchema = z.strictObject({
  action: importRowActionSchema,
  targetId: z.uuid().optional(),
});

export const decideRowsBodySchema = z.strictObject({
  rowIds: z.array(z.uuid()).min(1).max(500),
  action: importRowActionSchema,
});

export const createBatchBodySchema = z.strictObject({
  kind: importKindSchema,
  fileName: z.string().min(1).max(255),
  fileBase64: z.string().min(1),
});

export const mappingPresetSchema = z.strictObject({
  id: z.uuid(),
  orgId: z.uuid().nullable(),
  kind: importKindSchema,
  name: z.string(),
  mapping: importMappingSchema,
  builtin: z.boolean(),
});

export const mappingPresetListSchema = z.strictObject({
  items: z.array(mappingPresetSchema),
});

export const suggestMappingResponseSchema = z.strictObject({
  mapping: importMappingSchema,
  unmatchedTargets: z.array(z.string()),
});

export const validateBatchResponseSchema = z.strictObject({
  status: importBatchStatusSchema,
  rowCount: z.number(),
  errorCount: z.number(),
});

export const commitBatchResponseSchema = z.strictObject({
  status: importBatchStatusSchema,
  summary: z.record(z.string(), z.unknown()),
});

export const rollbackBatchResponseSchema = z.strictObject({
  status: importBatchStatusSchema,
  summary: z.record(z.string(), z.unknown()),
});
