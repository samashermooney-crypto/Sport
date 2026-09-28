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

export const privacyRequestKindSchema = z.enum([
  'access',
  'correction',
  'deletion',
]);
export const privacyRequestSubjectTypeSchema = z.enum(['person', 'household']);
export const privacyRequestStatusSchema = z.enum([
  'pending',
  'in_review',
  'approved',
  'completed',
  'rejected',
]);

export const privacyRequestSchema = z.strictObject({
  id: z.uuid(),
  kind: privacyRequestKindSchema,
  subjectType: privacyRequestSubjectTypeSchema,
  subjectId: z.uuid(),
  status: privacyRequestStatusSchema,
  resolutionNote: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const privacyRequestListSchema = z.strictObject({
  items: z.array(privacyRequestSchema),
});

export const createPrivacyRequestSchema = z.strictObject({
  kind: privacyRequestKindSchema,
  subjectType: privacyRequestSubjectTypeSchema,
  subjectId: z.uuid(),
});

export const updatePrivacyRequestSchema = z.strictObject({
  status: privacyRequestStatusSchema,
  version: z.number().int().positive(),
  resolutionNote: z.string().trim().max(1000).optional(),
});

export const privacySubjectExportSchema = z.strictObject({
  requestId: z.uuid(),
  generatedAt: z.iso.datetime(),
  subjectType: privacyRequestSubjectTypeSchema,
  subjectId: z.uuid(),
  data: z.record(z.string(), z.unknown()),
});

export const retentionPolicyRulesSchema = z.strictObject({
  financialRecordsYears: z.literal(7),
  waiverAndSafetyYearsAfterAge18: z.literal(7),
  waiverAndSafetyYearsAfterEvent: z.literal(7),
  backgroundCheckValidityPlusYears: z.literal(1),
  messagesYears: z.literal(3),
  evaluationScoresYearsAfterEvent: z.literal(2),
  expiredTokensDays: z.literal(30),
});

export const retentionPolicySchema = z.strictObject({
  version: z.number().int().positive(),
  rules: retentionPolicyRulesSchema,
  updatedAt: z.iso.datetime().nullable(),
});
