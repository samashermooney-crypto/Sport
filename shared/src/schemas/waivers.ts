import { z } from 'zod';

export const waiverDocumentCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  bodyText: z.string().trim().min(20).max(40_000),
  requires: z.enum(['guardian_if_minor', 'participant', 'both']),
  renewal: z.enum(['every_registration', 'annual_season', 'once']),
});

export const waiverDocumentUpdateSchema = waiverDocumentCreateSchema.extend({
  expectedVersion: z.int().positive(),
});

export const waiverDocumentSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  bodyText: z.string(),
  version: z.int().positive(),
  requires: z.enum(['guardian_if_minor', 'participant', 'both']),
  renewal: z.enum(['every_registration', 'annual_season', 'once']),
  templateUnreviewed: z.boolean(),
  publishedAt: z.iso.datetime().nullable(),
  retiredAt: z.iso.datetime().nullable(),
  supersedesId: z.uuid().nullable(),
});

export const waiverDocumentListSchema = z.strictObject({
  items: z.array(waiverDocumentSchema),
});

export const waiverSignatureCreateSchema = z.strictObject({
  participantPersonId: z.uuid(),
  signerPersonId: z.uuid().nullable().default(null),
  signerNameTyped: z.string().trim().min(1).max(200),
  method: z.enum(['online_typed', 'online_drawn']).default('online_typed'),
  signatureFileId: z.uuid().nullable().default(null),
  registrationId: z.uuid().nullable().default(null),
});

export const waiverSignatureSchema = z.strictObject({
  id: z.uuid(),
  waiverDocumentId: z.uuid(),
  documentVersion: z.int().positive(),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  participantPersonId: z.uuid(),
  signerAccountId: z.uuid(),
  signerPersonId: z.uuid().nullable(),
  signerNameTyped: z.string(),
  method: z.enum(['online_typed', 'online_drawn', 'paper_recorded_by_staff']),
  signedAt: z.iso.datetime(),
});

export const waiverSignatureListSchema = z.strictObject({
  items: z.array(waiverSignatureSchema),
});

export type WaiverDocumentCreate = z.output<typeof waiverDocumentCreateSchema>;
export type WaiverDocumentUpdate = z.output<typeof waiverDocumentUpdateSchema>;
export type WaiverSignatureCreate = z.output<
  typeof waiverSignatureCreateSchema
>;
