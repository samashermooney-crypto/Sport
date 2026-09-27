import { z } from 'zod';

const credentialRoleSchema = z.enum([
  'head_coach',
  'assistant_coach',
  'team_manager',
  'trainer',
  'treasurer',
  'official',
  'volunteer',
  'evaluator',
]);

export const credentialBodySchema = z.strictObject({
  personId: z.uuid(),
  credentialTypeId: z.uuid(),
  identifier: z.string().trim().max(300).optional(),
  issuedOn: z.iso.date().nullable().optional(),
  expiresOn: z.iso.date().nullable().optional(),
  fileId: z.uuid().nullable().optional(),
});

const credentialValiditySchema = z.union([
  z.strictObject({ months: z.number().int().positive().max(600) }),
  z.strictObject({
    expires_on_month_day: z
      .string()
      .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/),
  }),
  z.strictObject({ never: z.literal(true) }),
]);

export const credentialTypeUpdateSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).nullable(),
  validity: credentialValiditySchema,
  blocksActivation: z.boolean(),
  renewalReminderDays: z.array(z.number().int().min(0).max(365)).max(8),
  active: z.boolean(),
  version: z.number().int().positive(),
});

export const credentialSubmissionUpdateSchema = z.strictObject({
  identifier: z.string().trim().max(300).optional(),
  issuedOn: z.iso.date().nullable(),
  expiresOn: z.iso.date().nullable(),
  fileId: z.uuid().nullable(),
  version: z.number().int().positive(),
});

export const credentialRevokeSchema = z.strictObject({
  reason: z.string().trim().min(8).max(2000),
  version: z.number().int().positive(),
});

export const credentialReviewSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(2000).optional(),
  version: z.number().int().positive(),
});

export const credentialRequirementSchema = z.strictObject({
  role: credentialRoleSchema,
  credentialTypeId: z.uuid(),
  scopeType: z.enum(['org', 'program']),
  scopeId: z.uuid().nullable().optional(),
  minimumAge: z.number().int().min(0).max(120).default(18),
  active: z.boolean().default(true),
});

export const requirementUpdateSchema = credentialRequirementSchema.extend({
  id: z.uuid(),
  version: z.number().int().positive(),
});

export const complianceOverrideSchema = z.strictObject({
  personId: z.uuid(),
  role: credentialRoleSchema,
  scopeType: z.enum(['org', 'program']),
  scopeId: z.uuid().nullable().optional(),
  reason: z.string().trim().min(8).max(2000),
  expiresOn: z.iso.date(),
});

export const backgroundSettingsSchema = z.strictObject({
  providerMode: z.enum(['manual', 'checkr']),
  volunteerPaysFee: z.boolean(),
  package: z.string().trim().min(1).max(100),
  disclosureVersion: z.string().trim().min(1).max(100),
  disclosureText: z.string().trim().min(100).max(20_000),
  authorizationVersion: z.string().trim().min(1).max(100),
  authorizationText: z.string().trim().min(20).max(5000),
  preAdverseNoticeText: z.string().trim().min(40).max(20_000),
  rightsSummaryText: z.string().trim().min(40).max(20_000),
  adverseNoticeText: z.string().trim().min(40).max(20_000),
  fcraHolidays: z.array(z.iso.date()).max(100),
  version: z.number().int().positive(),
});

export const backgroundConsentSchema = z.strictObject({
  personId: z.uuid(),
  disclosureVersion: z.string().min(1).max(100),
  authorizationVersion: z.string().min(1).max(100),
  accepted: z.literal(true),
});

export const backgroundResultSchema = z.strictObject({
  status: z.enum(['clear', 'consider', 'suspended', 'canceled', 'expired']),
  resultSummary: z.enum(['clear', 'consider', 'adverse_action']),
  details: z.string().max(20_000).optional(),
  version: z.number().int().positive(),
});

export const backgroundAdjudicationSchema = z.strictObject({
  adjudication: z.enum(['eligible', 'ineligible']),
  reason: z.string().trim().min(8).max(2000),
  version: z.number().int().positive(),
});

export const cardBodySchema = z.strictObject({
  personId: z.uuid(),
  cardKind: z.enum(['player', 'staff']),
  programId: z.uuid().nullable().optional(),
  seasonId: z.uuid().nullable().optional(),
  cardNumber: z.string().trim().min(1).max(80),
  validUntil: z.iso.date(),
  photoFileId: z.uuid().nullable().optional(),
});

export const cardStatusSchema = z.strictObject({
  status: z.enum(['active', 'revoked']),
  version: z.number().int().positive(),
});
