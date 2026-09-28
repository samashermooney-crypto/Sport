import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase } from '../../../src/db/kysely';
import type { OrgContext } from '../../../src/db/withOrg';
import type {
  EmailMessage,
  EmailSender,
} from '../../../src/integrations/email/sender';
import type { EncryptionKeys } from '../../../src/lib/crypto';
import type { GuestDonationCheckoutPort } from '../../../src/modules/fundraising/checkout';
import {
  createCampaign,
  createGuestDonation,
  markDonationFailed,
  markDonationPaid,
  publicCampaign,
  saveFundraisingSettings,
  setCampaignStatus,
} from '../../../src/modules/fundraising/service';
import { systemWorkerActorId } from '../../../src/modules/jobs/credentials-expiry';
import { createTestFactories } from '../../../test/factories';

let database: ReturnType<typeof createDatabase>;
const encryption: EncryptionKeys = {
  activeKid: 'test-key',
  keys: new Map([['test-key', Buffer.alloc(32, 7)]]),
};

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => database.destroy());

async function publishedCampaign() {
  const factories = createTestFactories(database);
  const actor = await factories.actor();
  await database
    .updateTable('organizations')
    .set({ status: 'active' })
    .where('id', '=', actor.orgId)
    .execute();
  const now = new Date('2026-09-27T12:00:00.000Z');
  const slug = `team-travel-${randomUUID().slice(0, 8)}`;
  const campaignId = await createCampaign(database, actor, {
    name: 'Team travel fund',
    slug,
    goalCents: 100_000,
    startsAt: '2026-09-01T00:00:00.000Z',
    descriptionHtml: '<p>Support the team.</p>',
    showDonorNames: true,
  });
  await setCampaignStatus(
    database,
    actor,
    campaignId,
    { status: 'published', expectedVersion: 1 },
    now,
  );
  return { actor, campaignId, slug, now };
}

function checkoutPort() {
  const sessions = new Map<string, string>();
  const create = vi.fn<GuestDonationCheckoutPort['create']>((input) => {
    const sessionId =
      sessions.get(input.idempotencyKey) ?? `session_${randomUUID()}`;
    sessions.set(input.idempotencyKey, sessionId);
    return Promise.resolve({
      checkoutSessionId: sessionId,
      url: `https://checkout.example.test/${sessionId}`,
    });
  });
  return { create, createSession: { create } as GuestDonationCheckoutPort };
}

describe('guest fundraising donations', () => {
  it('binds an idempotency key to the exact guest donation details', async () => {
    const { actor, campaignId, slug, now } = await publishedCampaign();
    const checkout = checkoutPort();
    const idempotencyKey = randomUUID();
    const input = {
      orgId: actor.orgId,
      campaignId,
      donorName: '  Jamie Donor  ',
      donorEmail: 'JAMIE@example.test',
      amountCents: 3_000,
      anonymous: true,
      idempotencyKey,
      appUrl: 'https://app.example.test',
    };

    const first = await createGuestDonation(
      database,
      checkout.createSession,
      input,
      now,
    );
    const replay = await createGuestDonation(
      database,
      checkout.createSession,
      { ...input, donorName: 'Different Donor' },
      now,
    ).catch((error: unknown) => error);

    expect(first.donationId).toBeDefined();
    expect(replay).toMatchObject({
      code: 'CONFLICT',
      message:
        'Donation idempotency key was already used with different details',
    });
    expect(checkout.create).toHaveBeenCalledTimes(1);
    const organizationSlug = (
      await database
        .selectFrom('organizations')
        .select('slug')
        .where('id', '=', actor.orgId)
        .executeTakeFirstOrThrow()
    ).slug;
    expect(checkout.create).toHaveBeenCalledWith(
      expect.objectContaining({
        donorName: 'Jamie Donor',
        donorEmail: 'jamie@example.test',
        campaignId,
        successUrl: `https://app.example.test/site/${organizationSlug}/fundraisers/${slug}?status=success`,
        cancelUrl: `https://app.example.test/site/${organizationSlug}/fundraisers/${slug}?status=cancel`,
      }),
    );
  });

  it('audits a provider-declared checkout failure and keeps its terminal state on replay', async () => {
    const { actor, campaignId, now } = await publishedCampaign();
    const checkout = checkoutPort();
    const donation = await createGuestDonation(
      database,
      checkout.createSession,
      {
        orgId: actor.orgId,
        campaignId,
        donorName: 'Casey Donor',
        donorEmail: 'casey@example.test',
        amountCents: 2_500,
        anonymous: true,
        idempotencyKey: randomUUID(),
        appUrl: 'https://app.example.test',
      },
      now,
    );
    const webhookContext: OrgContext = {
      orgId: actor.orgId,
      actor: { accountId: systemWorkerActorId },
    };
    const failure = {
      donationId: donation.donationId,
      checkoutSessionId: donation.checkoutSessionId,
      reason: 'provider reported payment failure',
    };

    await expect(
      markDonationFailed(database, webhookContext, failure, now),
    ).resolves.toMatchObject({
      donationId: donation.donationId,
      status: 'failed',
    });
    await expect(
      markDonationFailed(database, webhookContext, failure, now),
    ).resolves.toMatchObject({
      donationId: donation.donationId,
      status: 'failed',
    });

    const factories = createTestFactories(database);
    const persisted = await factories.scoped(actor, (trx) =>
      trx
        .selectFrom('donations')
        .select('status')
        .where('org_id', '=', actor.orgId)
        .where('id', '=', donation.donationId)
        .executeTakeFirstOrThrow(),
    );
    const auditEvents = await factories.scoped(actor, (trx) =>
      trx
        .selectFrom('audit_log')
        .select('action')
        .where('org_id', '=', actor.orgId)
        .where('entity_id', '=', donation.donationId)
        .where('action', '=', 'fundraising.donation_failed')
        .execute(),
    );
    expect(persisted.status).toBe('failed');
    expect(auditEvents).toHaveLength(1);
  });

  it('retries an unsent tax acknowledgment and updates the public campaign total', async () => {
    const { actor, campaignId, slug, now } = await publishedCampaign();
    await saveFundraisingSettings(database, actor, encryption, {
      isNonprofit: true,
      ein: '123456789',
      showFullEin: false,
      expectedVersion: 1,
    });
    const checkout = checkoutPort();
    const donation = await createGuestDonation(
      database,
      checkout.createSession,
      {
        orgId: actor.orgId,
        campaignId,
        donorName: 'Taylor Donor',
        donorEmail: 'taylor@example.test',
        amountCents: 30_000,
        anonymous: false,
        idempotencyKey: randomUUID(),
        appUrl: 'https://app.example.test',
      },
      now,
    );
    const sent: EmailMessage[] = [];
    let attempts = 0;
    const email: EmailSender = {
      send(message) {
        sent.push(message);
        attempts += 1;
        if (attempts === 1)
          return Promise.reject(new Error('temporary provider failure'));
        return Promise.resolve({ providerId: 'fake-receipt-2' });
      },
    };
    const webhookContext: OrgContext = {
      orgId: actor.orgId,
      actor: { accountId: systemWorkerActorId },
    };
    const payment = {
      donationId: donation.donationId,
      checkoutSessionId: donation.checkoutSessionId,
      providerPaymentId: 'fake-payment-300',
    };

    await expect(
      markDonationPaid(
        database,
        webhookContext,
        encryption,
        email,
        payment,
        now,
      ),
    ).rejects.toThrow('temporary provider failure');
    await expect(
      markDonationPaid(
        database,
        webhookContext,
        encryption,
        email,
        payment,
        now,
      ),
    ).resolves.toMatchObject({ donationId: donation.donationId });

    expect(sent).toHaveLength(2);
    const receipt = sent[1];
    if (!receipt) throw new Error('Expected a donation receipt email');
    expect(receipt).toMatchObject({
      to: 'taylor@example.test',
      kind: 'transactional',
      idempotencyKey: `donation-receipt:${actor.orgId}:${donation.donationId}`,
    });
    expect(receipt.text).toContain('EIN ends in 6789');
    expect(receipt.text).toContain(
      'No goods or services were provided in exchange for this contribution.',
    );
    expect(receipt.text).not.toContain('123456789');

    const orgSlug = (
      await database
        .selectFrom('organizations')
        .select('slug')
        .where('id', '=', actor.orgId)
        .executeTakeFirstOrThrow()
    ).slug;
    const totals = await publicCampaign(database, orgSlug, slug);
    expect(totals.totalRaisedCents).toBe(30_000);
    expect(totals.donorWall ?? []).toHaveLength(1);
    expect(totals.donorWall?.[0]?.donorName).toBe('Taylor Donor');
  });
});
