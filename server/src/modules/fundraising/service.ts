import { sql, type Kysely } from 'kysely';

import { allocateOrgNumber } from '../../db/orgCounters';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';
import { encryptRestricted, decryptRestricted } from '../../lib/crypto';
import type { EncryptionKeys } from '../../lib/crypto';
import { appendAuditEvent } from '../audit/service';
import { systemWorkerActorId } from '../jobs/credentials-expiry';

import type { GuestDonationCheckoutPort } from './checkout';

export class FundraisingConflictError extends Error {
  readonly status = 409;
  readonly code = 'CONFLICT';
}
export class FundraisingNotFoundError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
}
export class FundraisingCheckoutUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'CHECKOUT_UNAVAILABLE';
}

export async function createCampaign(
  database: Kysely<DB>,
  context: OrgContext,
  input: {
    name: string;
    slug: string;
    goalCents: number;
    startsAt: string;
    endsAt?: string | null | undefined;
    teamSeasonId?: string | null | undefined;
    descriptionHtml: string;
    imageFileId?: string | null | undefined;
    showDonorNames: boolean;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    const result = await trx
      .insertInto('fundraising_campaigns')
      .values({
        org_id: context.orgId,
        name: input.name,
        slug: input.slug,
        goal_cents: input.goalCents,
        starts_at: new Date(input.startsAt),
        ends_at: input.endsAt ? new Date(input.endsAt) : null,
        team_season_id: input.teamSeasonId ?? null,
        description_html: input.descriptionHtml,
        image_file_id: input.imageFileId ?? null,
        show_donor_names: input.showDonorNames,
        status: 'draft',
        created_by: context.actor.accountId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'fundraising.campaign_created',
      entityType: 'fundraising_campaign',
      entityId: result.id,
      changes: {
        goalCents: { tier: 'internal', after: input.goalCents },
        slug: { tier: 'internal', after: input.slug },
      },
    });
    return result.id;
  });
}

export async function setCampaignStatus(
  database: Kysely<DB>,
  context: OrgContext,
  campaignId: string,
  input: {
    status: 'published' | 'ended' | 'archived';
    expectedVersion: number;
  },
  now = new Date(),
) {
  return createWithOrg(database)(context, async (trx) => {
    const campaign = await trx
      .selectFrom('fundraising_campaigns')
      .select(['id', 'status', 'version', 'starts_at', 'ends_at'])
      .where('org_id', '=', context.orgId)
      .where('id', '=', campaignId)
      .forUpdate()
      .executeTakeFirst();
    if (!campaign) throw new FundraisingNotFoundError('Campaign not found');
    if (campaign.version !== input.expectedVersion)
      throw new FundraisingConflictError('Campaign changed');
    if (
      input.status === 'published' &&
      (campaign.status === 'archived' ||
        (campaign.ends_at && campaign.ends_at < now))
    )
      throw new FundraisingConflictError('Campaign is not open for publishing');
    await trx
      .updateTable('fundraising_campaigns')
      .set({ status: input.status, version: sql`version + 1`, updated_at: now })
      .where('org_id', '=', context.orgId)
      .where('id', '=', campaignId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'fundraising.campaign_status_changed',
      entityType: 'fundraising_campaign',
      entityId: campaignId,
      changes: {
        status: {
          tier: 'internal',
          before: campaign.status,
          after: input.status,
        },
      },
    });
    return { status: input.status, version: campaign.version + 1 };
  });
}

async function campaignView(
  database: Kysely<DB>,
  context: OrgContext,
  campaignId: string,
  includePrivate: boolean,
) {
  return createWithOrg(database)(context, async (trx) => {
    const row = await sql<{
      id: string;
      name: string;
      slug: string;
      goal_cents: number;
      starts_at: Date;
      ends_at: Date | null;
      team_season_id: string | null;
      description_html: string;
      status: 'draft' | 'published' | 'ended' | 'archived';
      show_donor_names: boolean;
      version: number;
      total_raised_cents: number;
      donor_count: number;
    }>`SELECT campaign.id, campaign.name, campaign.slug, campaign.goal_cents, campaign.starts_at, campaign.ends_at, campaign.team_season_id,
      campaign.description_html, campaign.status, campaign.show_donor_names, campaign.version,
      COALESCE(sum(donation.amount_cents) FILTER (WHERE donation.status = 'paid'), 0)::int AS total_raised_cents,
      count(donation.id) FILTER (WHERE donation.status = 'paid')::int AS donor_count
      FROM fundraising_campaigns campaign LEFT JOIN donations donation
        ON donation.org_id = campaign.org_id AND donation.campaign_id = campaign.id
      WHERE campaign.org_id = ${context.orgId} AND campaign.id = ${campaignId}
        AND (${includePrivate} OR (campaign.status = 'published' AND campaign.starts_at <= now() AND (campaign.ends_at IS NULL OR campaign.ends_at > now())))
      GROUP BY campaign.id`.execute(trx);
    const campaign = row.rows[0];
    if (!campaign) throw new FundraisingNotFoundError('Campaign not found');
    const donorWall =
      includePrivate || !campaign.show_donor_names
        ? []
        : (
            await sql<{
              donor_name: string;
              amount_cents: number;
              paid_at: Date;
            }>`
      SELECT donor_name, amount_cents, paid_at FROM donations
      WHERE org_id = ${context.orgId} AND campaign_id = ${campaignId} AND status = 'paid' AND anonymous = false
      ORDER BY paid_at DESC LIMIT 25`.execute(trx)
          ).rows.map((donor) => ({
            donorName: donor.donor_name,
            amountCents: donor.amount_cents,
            paidAt: donor.paid_at.toISOString(),
          }));
    return {
      id: campaign.id,
      name: campaign.name,
      slug: campaign.slug,
      goalCents: campaign.goal_cents,
      startsAt: campaign.starts_at.toISOString(),
      endsAt: campaign.ends_at?.toISOString() ?? null,
      teamSeasonId: campaign.team_season_id,
      descriptionHtml: campaign.description_html,
      status: campaign.status,
      totalRaisedCents: campaign.total_raised_cents,
      donorCount: campaign.donor_count,
      version: campaign.version,
      ...(!includePrivate ? { donorWall } : {}),
    };
  });
}

export async function listCampaigns(database: Kysely<DB>, context: OrgContext) {
  const rows = await createWithOrg(database)(context, (trx) =>
    trx
      .selectFrom('fundraising_campaigns')
      .select('id')
      .where('org_id', '=', context.orgId)
      .orderBy('created_at', 'desc')
      .execute(),
  );
  return Promise.all(
    rows.map((row) => campaignView(database, context, row.id, true)),
  );
}

export async function publicCampaign(
  database: Kysely<DB>,
  orgSlug: string,
  campaignSlug: string,
) {
  const organization = await database
    .selectFrom('organizations')
    .select(['id', 'status'])
    .where('slug', '=', orgSlug)
    .executeTakeFirst();
  if (!organization || organization.status !== 'active')
    throw new FundraisingNotFoundError('Campaign not found');
  const context: OrgContext = {
    orgId: organization.id,
    actor: { accountId: systemWorkerActorId },
  };
  const id = await createWithOrg(database)(context, async (trx) =>
    trx
      .selectFrom('fundraising_campaigns')
      .select('id')
      .where('org_id', '=', organization.id)
      .where('slug', '=', campaignSlug)
      .executeTakeFirst(),
  );
  if (!id) throw new FundraisingNotFoundError('Campaign not found');
  return {
    ...(await campaignView(database, context, id.id, false)),
    orgId: organization.id,
  };
}

export async function createGuestDonation(
  database: Kysely<DB>,
  checkout: GuestDonationCheckoutPort,
  input: {
    orgId: string;
    campaignId: string;
    donorName: string;
    donorEmail: string;
    amountCents: number;
    anonymous: boolean;
    dedication?: string | null | undefined;
    idempotencyKey: string;
    appUrl: string;
  },
  now = new Date(),
) {
  const context: OrgContext = {
    orgId: input.orgId,
    actor: { accountId: systemWorkerActorId },
  };
  const donation = await createWithOrg(database)(context, async (trx) => {
    const existing = await trx
      .selectFrom('donations')
      .select([
        'id',
        'receipt_number',
        'amount_cents',
        'checkout_session_id',
        'status',
      ])
      .where('org_id', '=', input.orgId)
      .where('creation_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (existing) return existing;
    const campaign = await trx
      .selectFrom('fundraising_campaigns')
      .select('id')
      .where('org_id', '=', input.orgId)
      .where('id', '=', input.campaignId)
      .where('status', '=', 'published')
      .where('starts_at', '<=', now)
      .where((eb) =>
        eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]),
      )
      .executeTakeFirst();
    if (!campaign)
      throw new FundraisingNotFoundError('Campaign is not accepting donations');
    const number = await allocateOrgNumber(
      trx,
      input.orgId,
      'donation_receipt',
    );
    const receiptNumber = `DON-${String(now.getUTCFullYear())}-${String(number).padStart(6, '0')}`;
    const result = await sql<{
      id: string;
    }>`INSERT INTO donations (org_id, campaign_id, donor_name, donor_email, amount_cents, anonymous, dedication, receipt_number, creation_key)
      VALUES (${input.orgId}, ${input.campaignId}, ${input.donorName}, ${input.donorEmail.toLowerCase()}, ${input.amountCents}, ${input.anonymous}, ${input.dedication ?? null}, ${receiptNumber}, ${input.idempotencyKey}) RETURNING id`.execute(
      trx,
    );
    const inserted = result.rows[0];
    if (!inserted)
      throw new FundraisingConflictError('Donation could not be recorded');
    return {
      id: inserted.id,
      receipt_number: receiptNumber,
      amount_cents: input.amountCents,
      checkout_session_id: null,
      status: 'pending',
    };
  });
  if (donation.status !== 'pending')
    throw new FundraisingConflictError('Donation is no longer pending');
  if (donation.checkout_session_id)
    return {
      donationId: donation.id,
      checkoutSessionId: donation.checkout_session_id,
      receiptNumber: donation.receipt_number,
      amountCents: donation.amount_cents,
    };
  const checkoutResult = await checkout.create({
    orgId: input.orgId,
    campaignId: input.campaignId,
    donationId: donation.id,
    amountCents: donation.amount_cents,
    donorName: input.donorName,
    donorEmail: input.donorEmail.toLowerCase(),
    successUrl: `${input.appUrl}/me/donations/${donation.id}?status=success`,
    cancelUrl: `${input.appUrl}/site/${encodeURIComponent(input.orgId)}/fundraisers/${encodeURIComponent(input.campaignId)}?status=cancel`,
    idempotencyKey: input.idempotencyKey,
  });
  const parsedUrl = new URL(checkoutResult.url);
  if (parsedUrl.protocol !== 'https:')
    throw new FundraisingCheckoutUnavailableError(
      'Donation checkout must use a hosted HTTPS URL',
    );
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .updateTable('donations')
      .set({
        checkout_session_id: checkoutResult.checkoutSessionId,
        updated_at: now,
      })
      .where('org_id', '=', input.orgId)
      .where('id', '=', donation.id)
      .where('status', '=', 'pending')
      .execute();
  });
  return {
    donationId: donation.id,
    checkoutSessionId: checkoutResult.checkoutSessionId,
    checkoutUrl: checkoutResult.url,
    receiptNumber: donation.receipt_number,
    amountCents: donation.amount_cents,
  };
}

function encryptionParts(value: Buffer) {
  const kidLength = value[0];
  if (!kidLength)
    throw new FundraisingConflictError('Encrypted tax identity is invalid');
  const keyVersion = value.subarray(1, 1 + kidLength).toString('utf8');
  const nonceStart = 1 + kidLength;
  return {
    keyVersion,
    nonce: value.subarray(nonceStart, nonceStart + 12),
    ciphertext: value.subarray(nonceStart + 12),
  };
}
function packEncryption(value: Buffer, nonce: Buffer, keyVersion: string) {
  const kid = Buffer.from(keyVersion, 'utf8');
  return Buffer.concat([Buffer.from([kid.length]), kid, nonce, value]);
}

export async function saveFundraisingSettings(
  database: Kysely<DB>,
  context: OrgContext,
  encryption: EncryptionKeys,
  input: {
    isNonprofit: boolean;
    ein?: string | null | undefined;
    showFullEin: boolean;
    expectedVersion?: number | undefined;
  },
) {
  return createWithOrg(database)(context, async (trx) => {
    const current = await trx
      .selectFrom('fundraising_settings')
      .select(['version', 'ein_ciphertext', 'ein_nonce', 'ein_key_version'])
      .where('org_id', '=', context.orgId)
      .forUpdate()
      .executeTakeFirst();
    if (current && input.expectedVersion !== current.version)
      throw new FundraisingConflictError('Fundraising settings changed');
    if (current && !input.expectedVersion)
      throw new FundraisingConflictError('Expected version is required');
    let ciphertext = current?.ein_ciphertext ?? null;
    let nonce = current?.ein_nonce ?? null;
    let keyVersion = current?.ein_key_version ?? null;
    if (input.ein) {
      const packed = encryptRestricted(
        Buffer.from(input.ein, 'utf8'),
        encryption,
      );
      const parts = encryptionParts(packed);
      ciphertext = parts.ciphertext;
      nonce = parts.nonce;
      keyVersion = parts.keyVersion;
    }
    if (input.showFullEin && (!input.isNonprofit || !ciphertext))
      throw new FundraisingConflictError(
        'Full EIN display requires a nonprofit and an EIN',
      );
    if (current) {
      await sql`UPDATE fundraising_settings SET is_nonprofit = ${input.isNonprofit}, ein_ciphertext = ${ciphertext}, ein_nonce = ${nonce}, ein_key_version = ${keyVersion}, show_full_ein = ${input.showFullEin}, version = version + 1, updated_by = ${context.actor.accountId}, updated_at = now() WHERE org_id = ${context.orgId}`.execute(
        trx,
      );
    } else {
      await sql`INSERT INTO fundraising_settings (org_id, is_nonprofit, ein_ciphertext, ein_nonce, ein_key_version, show_full_ein, updated_by) VALUES (${context.orgId}, ${input.isNonprofit}, ${ciphertext}, ${nonce}, ${keyVersion}, ${input.showFullEin}, ${context.actor.accountId})`.execute(
        trx,
      );
    }
    const lastFour =
      ciphertext && nonce && keyVersion
        ? decryptRestricted(
            packEncryption(
              Buffer.from(ciphertext),
              Buffer.from(nonce),
              keyVersion,
            ),
            encryption,
          )
            .toString('utf8')
            .slice(-4)
        : null;
    return {
      isNonprofit: input.isNonprofit,
      einLastFour: lastFour,
      showFullEin: input.showFullEin,
      version: (current?.version ?? 0) + 1,
    };
  });
}

export async function fundraisingSettings(
  database: Kysely<DB>,
  context: OrgContext,
  encryption: EncryptionKeys,
) {
  return createWithOrg(database)(context, async (trx) => {
    const settings = await trx
      .selectFrom('fundraising_settings')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .executeTakeFirst();
    if (!settings)
      return {
        isNonprofit: false,
        einLastFour: null,
        showFullEin: false,
        version: 1,
      };
    const decrypted =
      settings.ein_ciphertext && settings.ein_nonce && settings.ein_key_version
        ? decryptRestricted(
            packEncryption(
              Buffer.from(settings.ein_ciphertext),
              Buffer.from(settings.ein_nonce),
              settings.ein_key_version,
            ),
            encryption,
          ).toString('utf8')
        : null;
    return {
      isNonprofit: settings.is_nonprofit,
      einLastFour: decrypted?.slice(-4) ?? null,
      showFullEin: settings.show_full_ein,
      version: settings.version,
    };
  });
}

export async function markDonationPaid(
  database: Kysely<DB>,
  context: OrgContext,
  encryption: EncryptionKeys,
  email: EmailSender,
  input: {
    donationId: string;
    checkoutSessionId: string;
    providerPaymentId: string;
  },
  now = new Date(),
) {
  const donation = await createWithOrg(database)(context, async (trx) => {
    const current = await trx
      .selectFrom('donations')
      .select([
        'id',
        'campaign_id',
        'donor_name',
        'donor_email',
        'amount_cents',
        'receipt_number',
        'status',
        'provider_payment_id',
      ])
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.donationId)
      .where('checkout_session_id', '=', input.checkoutSessionId)
      .forUpdate()
      .executeTakeFirst();
    if (!current)
      throw new FundraisingNotFoundError('Donation checkout not found');
    if (current.status === 'paid') {
      if (current.provider_payment_id !== input.providerPaymentId)
        throw new FundraisingConflictError('Donation payment ID mismatch');
      return current;
    }
    const paid = await trx
      .updateTable('donations')
      .set({
        status: 'paid',
        provider_payment_id: input.providerPaymentId,
        paid_at: now,
        updated_at: now,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.donationId)
      .where('status', '=', 'pending')
      .returning([
        'id',
        'campaign_id',
        'donor_name',
        'donor_email',
        'amount_cents',
        'receipt_number',
        'status',
        'provider_payment_id',
      ])
      .executeTakeFirst();
    if (!paid)
      throw new FundraisingConflictError(
        'Donation payment was already processed',
      );
    await appendAuditEvent(trx, context, {
      action: 'fundraising.donation_paid',
      entityType: 'donation',
      entityId: paid.id,
      changes: {
        amountCents: { tier: 'internal', after: paid.amount_cents },
        receiptNumber: { tier: 'internal', after: paid.receipt_number },
      },
    });
    return paid;
  });
  const config = await fundraisingSettings(database, context, encryption);
  const settings = await createWithOrg(database)(context, async (trx) =>
    trx
      .selectFrom('fundraising_settings')
      .select([
        'ein_ciphertext',
        'ein_nonce',
        'ein_key_version',
        'show_full_ein',
      ])
      .where('org_id', '=', context.orgId)
      .executeTakeFirst(),
  );
  const org = await database
    .selectFrom('organizations')
    .select('name')
    .where('id', '=', context.orgId)
    .executeTakeFirstOrThrow();
  const encryptedEin =
    settings?.ein_ciphertext && settings.ein_nonce && settings.ein_key_version
      ? decryptRestricted(
          packEncryption(
            Buffer.from(settings.ein_ciphertext),
            Buffer.from(settings.ein_nonce),
            settings.ein_key_version,
          ),
          encryption,
        ).toString('utf8')
      : null;
  const taxAcknowledgment = config.isNonprofit
    ? `The ${encryptedEin && settings?.show_full_ein ? `EIN is ${encryptedEin}` : `EIN ends in ${config.einLastFour ?? 'not provided'}`}. No goods or services were provided in exchange for this contribution.`
    : 'This receipt acknowledges payment only and does not state that the contribution is tax deductible.';
  const amount = (donation.amount_cents / 100).toFixed(2);
  await email.send({
    to: donation.donor_email,
    subject: `Donation receipt ${donation.receipt_number}`,
    text: `Thank you, ${donation.donor_name}, for your $${amount} donation to ${org.name}. Receipt ${donation.receipt_number}. ${taxAcknowledgment}`,
    html: `<main><h1>Donation receipt</h1><p>Thank you, ${escapeHtml(donation.donor_name)}, for your $${amount} donation to ${escapeHtml(org.name)}.</p><p>Receipt ${escapeHtml(donation.receipt_number)} · ${now.toISOString().slice(0, 10)}</p><p>${escapeHtml(taxAcknowledgment)}</p></main>`,
    kind: 'transactional',
    idempotencyKey: `donation-receipt:${context.orgId}:${donation.id}`,
  });
  await createWithOrg(database)(context, (trx) =>
    trx
      .updateTable('donations')
      .set({ receipt_sent_at: now })
      .where('org_id', '=', context.orgId)
      .where('id', '=', donation.id)
      .where('status', '=', 'paid')
      .execute(),
  );
  return { donationId: donation.id, receiptNumber: donation.receipt_number };
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] ?? char,
  );
}

export async function donorStatement(
  database: Kysely<DB>,
  context: OrgContext,
  year: number,
) {
  return createWithOrg(database)(context, async (trx) => {
    const account = await trx
      .selectFrom('accounts')
      .select('email')
      .where('id', '=', context.actor.accountId)
      .where('email_verified_at', 'is not', null)
      .executeTakeFirst();
    if (!account)
      throw new FundraisingNotFoundError('Verified donor account not found');
    const result = await sql<{
      org_name: string;
      count: number;
      total: number;
      receipt_numbers: string[] | null;
    }>`SELECT organization.name AS org_name, count(donation.id)::int AS count,
      COALESCE(sum(donation.amount_cents), 0)::int AS total, array_agg(donation.receipt_number ORDER BY donation.paid_at) AS receipt_numbers
      FROM organizations organization LEFT JOIN donations donation ON donation.org_id = organization.id
        AND lower(donation.donor_email) = lower(${account.email}) AND donation.status = 'paid'
        AND donation.paid_at >= make_date(${year}, 1, 1) AND donation.paid_at < make_date(${year + 1}, 1, 1)
      WHERE organization.id = ${context.orgId} GROUP BY organization.name`.execute(
      trx,
    );
    const row = result.rows[0];
    if (!row) throw new FundraisingNotFoundError('Organization not found');
    return {
      year,
      orgName: row.org_name,
      donationCount: row.count,
      totalCents: row.total,
      receiptNumbers: row.receipt_numbers?.filter(Boolean) ?? [],
    };
  });
}
