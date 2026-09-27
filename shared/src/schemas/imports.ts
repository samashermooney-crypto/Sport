import { z } from 'zod';

export const importKindSchema = z.enum([
  'people',
  'households',
  'guardians',
  'emergency_contacts',
]);
export type ImportKind = z.infer<typeof importKindSchema>;

export const importDuplicateStrategySchema = z.enum([
  'skip',
  'update',
  'merge',
  'create',
]);
export type ImportDuplicateStrategy = z.infer<
  typeof importDuplicateStrategySchema
>;

export const importBatchCreateSchema = z.strictObject({
  kind: importKindSchema,
  filename: z.string().min(1).max(255),
  content: z.string().min(1),
  mapping: z.record(z.string(), z.string()),
  duplicateStrategy: importDuplicateStrategySchema.default('skip'),
});
export type ImportBatchCreate = z.infer<typeof importBatchCreateSchema>;

export const importRowIssueSchema = z.strictObject({
  field: z.string(),
  code: z.string(),
  message: z.string(),
});
export type ImportRowIssue = z.infer<typeof importRowIssueSchema>;

export const importRowPreviewSchema = z.strictObject({
  rowNumber: z.number().int().positive(),
  action: z.enum(['create', 'update', 'merge', 'skip', 'invalid']),
  issues: z.array(importRowIssueSchema),
  normalized: z.record(z.string(), z.unknown()).nullable(),
});
export type ImportRowPreview = z.infer<typeof importRowPreviewSchema>;

export const importBatchSchema = z.strictObject({
  id: z.uuid(),
  kind: importKindSchema,
  filename: z.string(),
  status: z.enum(['preview', 'committed', 'rolled_back', 'failed']),
  stats: z.object({
    total: z.number().int().nonnegative(),
    create: z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    merge: z.number().int().nonnegative(),
    skip: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  committedAt: z.iso.datetime().nullable(),
  rolledBackAt: z.iso.datetime().nullable(),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

export const importBatchPreviewSchema = z.strictObject({
  batch: importBatchSchema,
  rows: z.array(importRowPreviewSchema),
});
export type ImportBatchPreview = z.infer<typeof importBatchPreviewSchema>;

export const importBatchListSchema = z.strictObject({
  items: z.array(importBatchSchema),
});
export type ImportBatchList = z.infer<typeof importBatchListSchema>;

export const importMappingPresetSchema = z.strictObject({
  id: z.uuid(),
  kind: importKindSchema,
  name: z.string(),
  mapping: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime(),
});
export type ImportMappingPreset = z.infer<typeof importMappingPresetSchema>;

export const importMappingPresetSaveSchema = z.strictObject({
  kind: importKindSchema,
  name: z.string().min(1).max(120),
  mapping: z.record(z.string(), z.string()),
});

export const importMappingPresetListSchema = z.strictObject({
  items: z.array(importMappingPresetSchema),
});
