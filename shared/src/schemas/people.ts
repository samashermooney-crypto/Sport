import { z } from 'zod';

const editablePersonSchema = z.strictObject({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  preferredName: z.string().trim().max(120).nullable(),
  dateOfBirth: z.iso.date(),
  graduationYear: z.int().min(1900).max(2200).nullable(),
  gender: z.enum(['female', 'male', 'nonbinary', 'unspecified']),
  email: z.email().nullable(),
  phoneE164: z
    .string()
    .regex(/^\+[1-9][0-9]{1,14}$/)
    .nullable(),
  mediaConsent: z.enum(['granted', 'denied', 'unknown']),
});

export const personCreateSchema = editablePersonSchema.extend({
  graduationYear: editablePersonSchema.shape.graduationYear.default(null),
  preferredName: editablePersonSchema.shape.preferredName.default(null),
  gender: editablePersonSchema.shape.gender.default('unspecified'),
  email: editablePersonSchema.shape.email.default(null),
  phoneE164: editablePersonSchema.shape.phoneE164.default(null),
  mediaConsent: editablePersonSchema.shape.mediaConsent.default('unknown'),
});

export const personUpdateSchema = editablePersonSchema.partial().extend({
  expectedVersion: z.int().positive(),
});

export const personResponseSchema = z.strictObject({
  id: z.uuid(),
  orgId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  preferredName: z.string().nullable(),
  dateOfBirth: z.iso.date(),
  graduationYear: z.int().min(1900).max(2200).nullable(),
  age: z.int().nonnegative(),
  grade: z.string().nullable(),
  gender: z.enum(['female', 'male', 'nonbinary', 'unspecified']),
  email: z.string().nullable(),
  phoneE164: z.string().nullable(),
  mediaConsent: z.enum(['granted', 'denied', 'unknown']),
  photoFileId: z.uuid().nullable(),
  status: z.enum(['active', 'archived', 'merged', 'anonymized']),
  version: z.int().positive(),
});

export const peopleListSchema = z.strictObject({
  items: z.array(personResponseSchema),
  nextCursor: z.uuid().nullable(),
});

export const personPhotoUpdateSchema = z.strictObject({
  expectedVersion: z.int().positive(),
  fileId: z.uuid().nullable(),
});

export const guardianLinkCreateSchema = z.strictObject({
  email: z.email().max(254),
});

export const guardianLinkResponseSchema = z.strictObject({
  id: z.uuid(),
  accountId: z.uuid(),
  email: z.email(),
  name: z.string(),
  verifiedAt: z.iso.datetime(),
});

export const guardianLinksResponseSchema = z.strictObject({
  items: z.array(guardianLinkResponseSchema),
});

export const guardianInvitationResponseSchema = z.strictObject({
  id: z.uuid(),
  email: z.email(),
  expiresAt: z.iso.datetime(),
});

export const athleteInvitationSchema = z.strictObject({
  email: z.email().max(254),
});

export const athleteInvitationResponseSchema = z.strictObject({
  id: z.uuid(),
  email: z.email(),
  expiresAt: z.iso.datetime(),
});

export const athleteInvitationAcceptSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const athleteLinkResponseSchema = z.strictObject({
  accountId: z.uuid().nullable(),
  email: z.email().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  age: z.int().nonnegative(),
});

export const athleteInvitationAcceptedResponseSchema = z.strictObject({
  personId: z.uuid(),
  linkId: z.uuid(),
});

export const guardianInvitationAcceptSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const guardianInvitationAcceptedResponseSchema = z.strictObject({
  personId: z.uuid(),
  linkId: z.uuid(),
});

export const familyResponseSchema = z.strictObject({
  organizations: z.array(
    z.strictObject({
      orgId: z.uuid(),
      orgName: z.string(),
      people: z.array(
        z.strictObject({
          personId: z.uuid(),
          firstName: z.string(),
          lastName: z.string(),
          age: z.int().nonnegative(),
          relationship: z.enum(['guardian', 'self']),
        }),
      ),
    }),
  ),
});

export const personClaimInvitationSchema = z.strictObject({
  email: z.email().max(254),
});

export const personClaimInvitationResponseSchema = z.strictObject({
  id: z.uuid(),
  email: z.email(),
  expiresAt: z.iso.datetime(),
});

export const personClaimAcceptSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const personClaimAcceptedResponseSchema = z.strictObject({
  personId: z.uuid(),
  linkId: z.uuid(),
});

export const peopleQuerySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  status: z
    .enum(['active', 'archived', 'merged', 'anonymized'])
    .default('active'),
  gender: z.enum(['female', 'male', 'nonbinary', 'unspecified']).optional(),
  minAge: z.coerce.number().int().min(0).max(120).optional(),
  maxAge: z.coerce.number().int().min(0).max(120).optional(),
  grade: z.coerce.number().int().min(-1).max(12).optional(),
  householdId: z.uuid().optional(),
  programId: z.uuid().optional(),
  teamSeasonId: z.uuid().optional(),
  credentialStatus: z
    .enum([
      'pending_review',
      'verified',
      'rejected',
      'expired',
      'revoked',
      'none',
    ])
    .optional(),
  hasBalance: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const peopleFilterOptionsQuerySchema = z.strictObject({
  kind: z.enum(['program', 'team']),
  q: z.string().trim().max(120).optional(),
});

export const peopleFilterOptionsSchema = z.strictObject({
  items: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
});

export const duplicatePersonSchema = z.strictObject({
  id: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  dateOfBirth: z.iso.date(),
  email: z.string().nullable(),
  phoneE164: z.string().nullable(),
});

export const duplicatePairSchema = z.strictObject({
  a: duplicatePersonSchema,
  b: duplicatePersonSchema,
  reason: z.enum(['same_email', 'same_phone', 'similar_name_birth_date']),
});

export const duplicatesResponseSchema = z.strictObject({
  items: z.array(duplicatePairSchema),
});

export const personMergeCreateSchema = z.strictObject({
  survivorId: z.uuid(),
  mergedId: z.uuid(),
});

export const personMergeSummarySchema = z.strictObject({
  survivorName: z.string(),
  mergedName: z.string(),
  moved: z.record(z.string(), z.number()),
});

export const personMergeResponseSchema = z.strictObject({
  id: z.uuid(),
  survivorId: z.uuid(),
  mergedId: z.uuid(),
  summary: personMergeSummarySchema,
});
