import { z } from 'zod';

const uuid = z.uuid();
const cents = z.number().int().min(100).max(2_500_000);
export const campaignBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(160), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  goalCents: z.number().int().min(100).max(100_000_000), startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  teamSeasonId: uuid.nullable().optional(), descriptionHtml: z.string().max(12000), imageFileId: uuid.nullable().optional(), showDonorNames: z.boolean().default(false),
});
export const campaignStateSchema = z.strictObject({ status: z.enum(['published', 'ended', 'archived']), expectedVersion: z.number().int().positive() });
export const campaignSchema = z.strictObject({ id: uuid, name: z.string(), slug: z.string(), goalCents: z.number().int(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime().nullable(), teamSeasonId: uuid.nullable(), descriptionHtml: z.string(), status: z.enum(['draft', 'published', 'ended', 'archived']), totalRaisedCents: z.number().int().nonnegative(), donorCount: z.number().int().nonnegative(), version: z.number().int().positive() });
export const campaignListSchema = z.strictObject({ campaigns: z.array(campaignSchema) });
export const guestDonationBodySchema = z.strictObject({ donorName: z.string().trim().min(1).max(200), donorEmail: z.email(), amountCents: cents, anonymous: z.boolean().default(false), dedication: z.string().trim().max(500).nullable().optional(), captchaToken: z.string().min(1).max(4096) });
export const donationCheckoutSchema = z.strictObject({ donationId: uuid, checkoutUrl: z.url(), receiptNumber: z.string(), amountCents: cents });
export const publicCampaignSchema = campaignSchema.extend({ orgId: uuid, donorWall: z.array(z.strictObject({ donorName: z.string(), amountCents: cents, paidAt: z.iso.datetime() })) });
export const fundraisingSettingsSchema = z.strictObject({ isNonprofit: z.boolean(), einLastFour: z.string().regex(/^\d{4}$/).nullable(), showFullEin: z.boolean(), version: z.number().int().positive() });
export const fundraisingSettingsBodySchema = z.strictObject({ isNonprofit: z.boolean(), ein: z.string().regex(/^\d{9}$/).nullable().optional(), showFullEin: z.boolean(), expectedVersion: z.number().int().positive().optional() });
export const donorStatementSchema = z.strictObject({ year: z.number().int(), orgName: z.string(), donationCount: z.number().int().nonnegative(), totalCents: z.number().int().nonnegative(), receiptNumbers: z.array(z.string()) });
