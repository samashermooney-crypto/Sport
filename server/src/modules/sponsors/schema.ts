import { z } from 'zod';

const uuid = z.uuid();
const dateOnly = z.iso.date();
const dollars = z.number().int().min(0).max(100_000_000);

export const sponsorContactSchema = z.strictObject({
  name: z.string().trim().max(160).optional(),
  email: z.email().optional(),
  phone: z.string().trim().max(40).optional(),
  accountId: uuid.nullable().optional(),
});

export const sponsorPlacementSchema = z.strictObject({
  surface: z.enum([
    'website_home',
    'program_page',
    'team_page',
    'email_footer',
  ]),
  programId: uuid.nullable().optional(),
  teamSeasonId: uuid.nullable().optional(),
});

export const sponsorBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(180),
  contact: sponsorContactSchema.default({}),
  logoFileId: uuid.nullable().optional(),
  websiteUrl: z.url().nullable().optional(),
  tier: z.string().trim().min(1).max(80),
  amountCents: dollars,
  contractStart: dateOnly,
  contractEnd: dateOnly,
  placements: z.array(sponsorPlacementSchema).max(40).default([]),
  status: z.enum(['prospect', 'active']).default('prospect'),
});

export const sponsorPatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(180).optional(),
  contact: sponsorContactSchema.optional(),
  logoFileId: uuid.nullable().optional(),
  websiteUrl: z.url().nullable().optional(),
  tier: z.string().trim().min(1).max(80).optional(),
  amountCents: dollars.optional(),
  contractStart: dateOnly.optional(),
  contractEnd: dateOnly.optional(),
  placements: z.array(sponsorPlacementSchema).max(40).optional(),
  expectedVersion: z.number().int().positive(),
});

export const sponsorStatusBodySchema = z.strictObject({
  status: z.enum(['prospect', 'active', 'expired', 'archived']),
  expectedVersion: z.number().int().positive(),
});

export const sponsorInvoiceBodySchema = z.strictObject({
  accountId: uuid.optional(),
  amountCents: z.number().int().min(100).max(100_000_000).optional(),
  dueOn: dateOnly.optional(),
  memo: z.string().trim().max(500).optional(),
});

export const sponsorSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  contact: sponsorContactSchema,
  logoFileId: uuid.nullable(),
  websiteUrl: z.url().nullable(),
  tier: z.string(),
  amountCents: dollars,
  contractStart: dateOnly,
  contractEnd: dateOnly,
  placements: z.array(sponsorPlacementSchema),
  invoiceId: uuid.nullable(),
  invoiceStatus: z.string().nullable(),
  invoiceBalanceCents: z.number().int().nullable(),
  status: z.enum(['prospect', 'active', 'expired', 'archived']),
  renewalNotifiedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
});

export const sponsorListSchema = z.strictObject({
  sponsors: z.array(sponsorSchema),
});

export const publicSponsorSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  tier: z.string(),
  websiteUrl: z.url().nullable(),
  logoFileId: uuid.nullable(),
});

export const publicSponsorListSchema = z.strictObject({
  sponsors: z.array(publicSponsorSchema),
});
