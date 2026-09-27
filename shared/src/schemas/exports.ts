import { z } from 'zod';

export const organizationExportStatusSchema = z.enum([
  'queued',
  'building',
  'ready',
  'failed',
  'expired',
]);

export const organizationExportSchema = z.strictObject({
  id: z.uuid(),
  status: organizationExportStatusSchema,
  bytes: z.number().int().nonnegative().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const organizationExportListSchema = z.strictObject({
  items: z.array(organizationExportSchema),
});

export const organizationExportRequestResponseSchema = z.strictObject({
  export: organizationExportSchema,
});

export const organizationExportDownloadLinkSchema = z.strictObject({
  url: z.url(),
  expiresAt: z.iso.datetime(),
});
