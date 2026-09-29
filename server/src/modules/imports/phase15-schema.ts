import { z } from 'zod';

export const phase15ImportKindSchema = z.enum([
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
export type ImportKind = z.infer<typeof phase15ImportKindSchema>;
export const phase15ImportMappingSchema = z.strictObject({
  columns: z.record(z.string(), z.string().nullable()),
  options: z
    .strictObject({
      duplicateStrategy: z.enum(['ask', 'skip_all']).optional(),
      defaultStatus: z.string().optional(),
    })
    .optional(),
});

export type ImportIssue = {
  level: 'error' | 'warning';
  code: string;
  message: string;
  field?: string;
};

export type ImportDuplicate = {
  personId: string;
  name: string;
  reasons: string[];
};

export type ImportMapping = z.infer<typeof phase15ImportMappingSchema>;

export type ImportField = {
  key: string;
  label: string;
  type:
    | 'text'
    | 'email'
    | 'phone'
    | 'date'
    | 'datetime'
    | 'time'
    | 'int'
    | 'money'
    | 'bool'
    | 'enum'
    | 'gender'
    | 'list'
    | 'address';
  required: boolean;
  enum?: string[];
  description: string;
  aliases: string[];
};

export type ImportRow = {
  id: string;
  rowNumber: number;
  raw: Record<string, string>;
  normalized: Record<string, unknown> | null;
  issues: ImportIssue[];
  duplicates: ImportDuplicate[];
  action: 'create' | 'update' | 'merge' | 'skip';
  targetId: string | null;
};

export type ImportBatch = {
  id: string;
  orgId: string;
  kind: ImportKind;
  fileName: string;
  fileBytes: number;
  headers: string[];
  sampleRows: Record<string, string>[];
  mapping: ImportMapping | null;
  mappingPresetId: string | null;
  status:
    | 'uploaded'
    | 'mapped'
    | 'validating'
    | 'validated'
    | 'committing'
    | 'committed'
    | 'failed'
    | 'rolled_back';
  rowCount: number;
  errorCount: number;
  progress: { processed: number; total: number };
  summary: Record<string, unknown> | null;
  createdBy: string;
  committedAt: string | null;
  rolledBackAt: string | null;
  createdAt: string;
};
