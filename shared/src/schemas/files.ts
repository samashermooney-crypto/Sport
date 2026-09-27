import { z } from 'zod';

export const filePurposeSchema = z.enum([
  'image',
  'document',
  'import',
  'website_asset',
]);

export const fileSensitivitySchema = z.enum([
  'public',
  'internal',
  'sensitive',
  'restricted',
]);

export const fileUploadRequestSchema = z.strictObject({
  purpose: filePurposeSchema,
  mime: z.string().min(1).max(200),
  bytes: z.number().int().positive(),
  ownerType: z.string().max(80).optional(),
  ownerId: z.uuid().optional(),
  sensitivity: fileSensitivitySchema.optional(),
});

export const fileUploadResultSchema = z.strictObject({
  fileId: z.uuid(),
  uploadUrl: z.string().min(1),
});

export const fileRecordResponseSchema = z.strictObject({
  id: z.uuid(),
  orgId: z.uuid(),
  purpose: filePurposeSchema,
  ownerType: z.string().nullable(),
  ownerId: z.uuid().nullable(),
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  sensitivity: fileSensitivitySchema,
  uploadState: z.enum(['pending', 'complete', 'rejected']),
});

export const fileDownloadLinkSchema = z.strictObject({
  url: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
});
