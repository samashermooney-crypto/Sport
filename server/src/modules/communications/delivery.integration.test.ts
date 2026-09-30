import { createHmac, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { FakeEmailSender } from '../../integrations/email/sender';
import { FakeSmsSender } from '../../integrations/sms/sender';
import { parseTwilioInbound } from '../../integrations/sms/sender';
import type { SmsMessage } from '../../integrations/sms/sender';

import { recordWebhookStatus, retryCampaign, sendCampaign } from './delivery';
import { applyTwilioCommand } from './routes';
import { createCampaign, getCampaignStats, previewCampaign } from './service';

let database: ReturnType<typeof createDatabase>;
let withOrg: ReturnType<typeof createWithOrg>;
const orgId = randomUUID();
const ownerId = randomUUID();
const phone = '+13125550123';
const email = `${ownerId}@example.invalid`;
const context: OrgContext = { orgId, actor: { accountId: ownerId } };

const campaignDraft = (channel: 'email' | 'sms') => ({
  channels: [channel],
  category: 'operational' as const,
  audience: {
    include: { roles: ['board' as const] },
    exclude: {},
    filters: {},
  },
  subject: 'Season update',
  bodyHtml: '<p>Season update</p>',
  bodyText: 'Season update',
  smsText: 'Season update',
  pushText: '',
  localeVariants: {
    en: {
      subject: 'Season update',
      bodyHtml: '<p>Season update</p>',
      bodyText: 'Season update',
      smsText: 'Season update',
      pushText: '',
    },
    es: {
      subject: 'Actualización',
      bodyHtml: '<p>Actualización</p>',
      bodyText: 'Actualización',
      smsText: 'Actualización',
      pushText: '',
    },
  },
});

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth,phone_e164,phone_verified_at,timezone,locale) VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8)',
      [
        ownerId,
        email,
        'Casey',
        'Comms',
        '1980-01-01',
        phone,
        'America/Chicago',
        'en',
      ],
    );
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone,status,address) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [
        orgId,
        `delivery-${orgId.slice(0, 8)}`,
        'Delivery test',
        'club',
        'America/Chicago',
        'active',
        JSON.stringify({
          line1: '100 Test Way',
          city: 'Chicago',
          region: 'IL',
          postalCode: '60601',
        }),
      ],
    );
    await admin.query(
      'INSERT INTO org_memberships(id,org_id,account_id,status,joined_at) VALUES ($1,$2,$3,$4,now())',
      [randomUUID(), orgId, ownerId, 'active'],
    );
    await admin.query(
      'INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa) VALUES ($1,$2,$3,$4,$5,false)',
      [randomUUID(), orgId, ownerId, 'owner', 'org'],
    );
    await admin.query(
      "INSERT INTO communication_consent_events(id,org_id,account_id,phone_e164,action,source,version,consent_text) VALUES ($1,$2,$3,$4,'granted','settings','sms-v1-en','I agree to receive SMS messages. Reply STOP to opt out.')",
      [randomUUID(), orgId, ownerId, phone],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => database.destroy());

async function createDelivery(
  campaignId: string,
  input: {
    channel: 'email' | 'sms';
    providerId: string;
    address: string;
  },
) {
  const id = randomUUID();
  await withOrg(context, async (trx) => {
    await trx
      .insertInto('message_deliveries')
      .values({
        id,
        org_id: orgId,
        campaign_id: campaignId,
        notification_id: null,
        recipient_account_id: ownerId,
        person_id: null,
        channel: input.channel,
        address: input.address,
        status: 'sent',
        provider_message_id: input.providerId,
        sent_at: new Date('2026-09-27T15:00:00Z'),
      })
      .execute();
  });
  return id;
}

describe('communications delivery lifecycle', () => {
  it('records the email provider receipt for a sent campaign', async () => {
    const campaign = await createCampaign(
      context,
      campaignDraft('email'),
      'https://athlentry.test',
      withOrg,
    );
    const emailSender = new FakeEmailSender();
    await sendCampaign(
      context,
      campaign.id,
      campaign.version,
      {
        email: emailSender,
        sms: new FakeSmsSender(),
        push: { send: () => Promise.resolve({ status: 'sent' as const }) },
        appUrl: 'https://athlentry.test',
      },
      { now: new Date('2026-09-28T14:00:00Z'), runWithOrg: withOrg },
    );
    expect(emailSender.messages).toHaveLength(1);
    const delivery = await withOrg(context, (trx) =>
      trx
        .selectFrom('message_deliveries')
        .select(['id', 'status', 'provider_message_id'])
        .where('campaign_id', '=', campaign.id)
        .executeTakeFirstOrThrow(),
    );
    expect(delivery).toMatchObject({
      status: 'sent',
      provider_message_id: 'fake-email-1',
    });
    const receipt = await withOrg(context, (trx) =>
      trx
        .selectFrom('provider_delivery_keys')
        .select('delivery_id')
        .where('tenant_org_id', '=', orgId)
        .where('provider_id', '=', 'fake-email-1')
        .executeTakeFirstOrThrow(),
    );
    expect(receipt.delivery_id).toBe(delivery.id);
  });

  it('refuses to queue email until the organization has a mailing address', async () => {
    const campaign = await createCampaign(
      context,
      campaignDraft('email'),
      'https://athlentry.test',
      withOrg,
    );
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    const emailSender = new FakeEmailSender();
    try {
      await admin.query(
        "UPDATE organizations SET address = '{}'::jsonb WHERE id = $1",
        [orgId],
      );
      await expect(
        sendCampaign(
          context,
          campaign.id,
          campaign.version,
          {
            email: emailSender,
            sms: new FakeSmsSender(),
            push: { send: () => Promise.resolve({ status: 'sent' as const }) },
            appUrl: 'https://athlentry.test',
          },
          { now: new Date('2026-09-28T14:00:00Z'), runWithOrg: withOrg },
        ),
      ).rejects.toMatchObject({
        status: 409,
        message:
          "Add your organization's mailing address in Settings before sending email.",
      });
    } finally {
      await admin.query(
        'UPDATE organizations SET address = $2::jsonb WHERE id = $1',
        [
          orgId,
          JSON.stringify({
            line1: '100 Test Way',
            city: 'Chicago',
            region: 'IL',
            postalCode: '60601',
          }),
        ],
      );
      await admin.end();
    }
    expect(emailSender.messages).toHaveLength(0);
    const queued = await withOrg(context, (trx) =>
      trx
        .selectFrom('message_deliveries')
        .select('id')
        .where('campaign_id', '=', campaign.id)
        .execute(),
    );
    expect(queued).toEqual([]);
  });

  it('schedules opted-in SMS at 22:00 recipient time and sends at 08:00', async () => {
    const draft = campaignDraft('sms');
    const campaign = await createCampaign(
      context,
      draft,
      'https://athlentry.test',
      withOrg,
    );
    const sms = new FakeSmsSender();
    const dependencies = {
      email: { send: () => Promise.resolve({ providerId: 'email-test' }) },
      sms,
      push: {
        send: () => Promise.resolve({ status: 'sent' as const }),
      },
      appUrl: 'https://athlentry.test',
    };
    const night = new Date('2026-09-28T03:00:00Z');
    await sendCampaign(context, campaign.id, campaign.version, dependencies, {
      now: night,
      runWithOrg: withOrg,
    });
    const queued = await withOrg(context, (trx) =>
      trx
        .selectFrom('message_deliveries')
        .select(['status', 'next_attempt_at', 'attempt_count'])
        .where('org_id', '=', orgId)
        .where('campaign_id', '=', campaign.id)
        .executeTakeFirstOrThrow(),
    );
    expect(queued).toMatchObject({ status: 'queued', attempt_count: 0 });
    expect(queued.next_attempt_at?.toISOString()).toBe(
      '2026-09-28T13:00:00.000Z',
    );
    expect(sms.messages).toHaveLength(0);

    await retryCampaign(
      context,
      campaign.id,
      dependencies,
      new Date('2026-09-28T13:00:00Z'),
      withOrg,
    );
    expect(sms.messages).toHaveLength(1);
    expect(sms.messages[0]).toMatchObject({ to: phone });
    expect(sms.messages[0]?.body).toContain('Season update');
    expect(sms.messages[0]?.body).toContain('Reply STOP to opt out.');
    const sent = await withOrg(context, (trx) =>
      trx
        .selectFrom('message_deliveries')
        .select(['status', 'attempt_count'])
        .where('org_id', '=', orgId)
        .where('campaign_id', '=', campaign.id)
        .executeTakeFirstOrThrow(),
    );
    expect(sent).toMatchObject({ status: 'sent', attempt_count: 1 });
  });

  it('retries transient SMS failures with backoff and stops after five attempts', async () => {
    const campaign = await createCampaign(
      context,
      campaignDraft('sms'),
      'https://athlentry.test',
      withOrg,
    );
    const attempts: string[] = [];
    const dependencies = {
      email: { send: () => Promise.resolve({ providerId: 'email-test' }) },
      sms: {
        send(message: SmsMessage) {
          attempts.push(message.to);
          return Promise.reject(new Error('Temporary provider failure'));
        },
      },
      push: { send: () => Promise.resolve({ status: 'sent' as const }) },
      appUrl: 'https://athlentry.test',
    };
    const firstAt = new Date('2026-09-28T14:00:00Z');
    await sendCampaign(context, campaign.id, campaign.version, dependencies, {
      now: firstAt,
      runWithOrg: withOrg,
    });
    for (let attempt = 1; attempt < 5; attempt += 1) {
      const queued = await withOrg(context, (trx) =>
        trx
          .selectFrom('message_deliveries')
          .select('next_attempt_at')
          .where('org_id', '=', orgId)
          .where('campaign_id', '=', campaign.id)
          .executeTakeFirstOrThrow(),
      );
      expect(queued.next_attempt_at).not.toBeNull();
      await retryCampaign(
        context,
        campaign.id,
        dependencies,
        queued.next_attempt_at as Date,
        withOrg,
      );
    }
    const failed = await withOrg(context, (trx) =>
      trx
        .selectFrom('message_deliveries')
        .select(['status', 'attempt_count', 'next_attempt_at'])
        .where('org_id', '=', orgId)
        .where('campaign_id', '=', campaign.id)
        .executeTakeFirstOrThrow(),
    );
    expect(failed).toMatchObject({
      status: 'failed',
      attempt_count: 5,
      next_attempt_at: null,
    });
    expect(attempts).toEqual(Array.from({ length: 5 }, () => phone));
  });

  it('maps simulated email webhooks to delivery stats and suppresses bounces', async () => {
    const campaign = await createCampaign(
      context,
      campaignDraft('email'),
      'https://athlentry.test',
      withOrg,
    );
    const emailId = 'email-provider-opened';
    const emailDeliveryId = await createDelivery(campaign.id, {
      channel: 'email',
      providerId: emailId,
      address: email,
    });
    for (const status of [
      'email.delivered',
      'email.opened',
      'email.clicked',
      'email.clicked',
    ])
      await recordWebhookStatus(
        context,
        emailId,
        'email',
        status,
        new Date('2026-09-27T16:00:00Z'),
        withOrg,
      );
    const clicked = await withOrg(context, (trx) =>
      trx
        .selectFrom('message_deliveries')
        .select(['id', 'status', 'version'])
        .where('org_id', '=', orgId)
        .where('id', '=', emailDeliveryId)
        .executeTakeFirstOrThrow(),
    );
    expect(clicked.status).toBe('clicked');
    expect(
      (await getCampaignStats(context, campaign.id, withOrg)).counts,
    ).toEqual({ email: { clicked: 1 } });

    const bouncedCampaign = await createCampaign(
      context,
      campaignDraft('email'),
      'https://athlentry.test',
      withOrg,
    );
    await createDelivery(bouncedCampaign.id, {
      channel: 'email',
      providerId: 'email-provider-bounced',
      address: 'bounce@example.invalid',
    });
    await recordWebhookStatus(
      context,
      'email-provider-bounced',
      'email',
      'email.bounced',
      new Date('2026-09-27T16:00:00Z'),
      withOrg,
    );
    const suppression = await withOrg(context, (trx) =>
      trx
        .selectFrom('suppressions')
        .select(['channel', 'address', 'reason'])
        .where('org_id', '=', orgId)
        .where('channel', '=', 'email')
        .where('address', '=', 'bounce@example.invalid')
        .executeTakeFirstOrThrow(),
    );
    expect(suppression).toEqual({
      channel: 'email',
      address: 'bounce@example.invalid',
      reason: 'bounce',
    });
  });

  it('applies SMS STOP suppression globally and restores delivery after START', async () => {
    const campaign = await createCampaign(
      context,
      campaignDraft('sms'),
      'https://athlentry.test',
      withOrg,
    );
    const callbackUrl =
      'https://athlentry.test/api/v1/communications/webhooks/twilio/inbound';
    const authToken = 'isolated-test-token';
    const signedInbound = (body: string, messageSid: string) => {
      const params = {
        From: phone,
        To: '+13125550000',
        Body: body,
        MessageSid: messageSid,
      };
      const signedValue = Object.keys(params)
        .sort()
        .reduce(
          (value, key) => value + key + params[key as keyof typeof params],
          callbackUrl,
        );
      return parseTwilioInbound({
        url: callbackUrl,
        params,
        signature: createHmac('sha1', authToken)
          .update(signedValue)
          .digest('base64'),
        authToken,
      });
    };
    const stop = signedInbound('STOP', 'SM-stop-fixture');
    expect(stop.command).toBe('STOP');
    await applyTwilioCommand(
      { database },
      withOrg,
      stop.from,
      'revoked',
      stop.messageSid,
    );
    const stopped = await withOrg(context, (trx) =>
      trx
        .selectFrom('suppressions')
        .select(['org_id', 'channel', 'address', 'reason'])
        .where('org_id', 'is', null)
        .where('channel', '=', 'sms')
        .where('address', '=', phone)
        .executeTakeFirstOrThrow(),
    );
    expect(stopped).toEqual({
      org_id: null,
      channel: 'sms',
      address: phone,
      reason: 'stop',
    });
    expect(
      (await previewCampaign(context, campaign.id, new Date(), withOrg)).counts,
    ).toEqual({ sms: 0 });

    const start = signedInbound('START', 'SM-start-fixture');
    expect(start.command).toBe('START');
    await applyTwilioCommand(
      { database },
      withOrg,
      start.from,
      'granted',
      start.messageSid,
    );
    const cleared = await withOrg(context, (trx) =>
      trx
        .selectFrom('suppressions')
        .select('id')
        .where('org_id', 'is', null)
        .where('channel', '=', 'sms')
        .where('address', '=', phone)
        .executeTakeFirst(),
    );
    expect(cleared).toBeUndefined();
    expect(
      (await previewCampaign(context, campaign.id, new Date(), withOrg)).counts,
    ).toEqual({ sms: 1 });
    const consentEvents = await withOrg(context, (trx) =>
      trx
        .selectFrom('communication_consent_events')
        .select(['action', 'source', 'provider_message_id'])
        .where('org_id', '=', orgId)
        .where('account_id', '=', ownerId)
        .where('phone_e164', '=', phone)
        .where('source', 'in', ['twilio_stop', 'twilio_start'])
        .execute(),
    );
    expect(consentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'revoked',
          source: 'twilio_stop',
          provider_message_id: 'SM-stop-fixture',
        }),
        expect.objectContaining({
          action: 'granted',
          source: 'twilio_start',
          provider_message_id: 'SM-start-fixture',
        }),
      ]),
    );
  });
});
