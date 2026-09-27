import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { quietHoursDecision } from '@shared/policies/quiet-hours';
import { sql } from 'kysely';
import React from 'react';

import { getDatabase } from '../../db/kysely';
import type { Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';
import { renderEmailLayout } from '../../integrations/email/templates/layout';
import type { PushMessage, PushSender } from '../../integrations/push/sender';
import { sendPushAndCleanup } from '../../integrations/push/sender';
import type { SmsSender } from '../../integrations/sms/sender';
import { appendAuditEvent } from '../audit/service';

import type { ResolvedRecipient } from './audience';
import { resolveAudience } from './audience';
import {
  escapeHtmlText,
  htmlToText,
  renderMergeFields,
  sanitizeCampaignHtml,
  smsSegmentCount,
} from './content';
import { audienceSpecSchema, localeContentSchema } from './schema';
import type { CampaignRow } from './service';
import {
  CommunicationsAccessError,
  getCampaignForDelivery,
  markCampaignFinished,
  markCampaignSending,
} from './service';

export type PushSubscriptionValue = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
export type NotificationSink = (input: {
  context: OrgContext;
  accountId: string;
  type:
    | 'communications.campaign'
    | 'communications.emergency'
    | 'communications.chat_message';
  payload: Record<string, string>;
}) => Promise<string>;

export type DeliveryDependencies = {
  email: EmailSender;
  sms: SmsSender;
  push: PushSender;
  appUrl: string;
  notifications?: NotificationSink;
  now?: () => Date;
  removePushSubscription?: (endpoint: string) => Promise<void>;
};

export const emailUnsubscribeSecret = (): string => {
  const secret = process.env.COMMUNICATIONS_UNSUBSCRIBE_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === 'production')
    throw new Error(
      'Communications unsubscribe signing secret is not configured',
    );
  return 'athlentry-local-preview-unsubscribe-token-key';
};

type UnsubscribeClaims = {
  orgId: string;
  accountId: string;
  category: 'announcement' | 'marketing';
  channel: 'email';
  expiresAt: number;
  nonce: string;
};

export function createUnsubscribeToken(
  claims: Omit<UnsubscribeClaims, 'nonce'>,
  secret = emailUnsubscribeSecret(),
): string {
  const category: string = claims.category;
  if (category !== 'announcement' && category !== 'marketing')
    throw new RangeError(
      'Operational and emergency messages cannot be unsubscribed',
    );
  const payload = Buffer.from(
    JSON.stringify({ ...claims, nonce: randomBytes(12).toString('base64url') }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyUnsubscribeToken(
  token: string,
  now = new Date(),
  secret = emailUnsubscribeSecret(),
): UnsubscribeClaims {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra)
    throw new Error('Unsubscribe token is invalid');
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('Unsubscribe token is invalid');
  const parsed: unknown = JSON.parse(
    Buffer.from(payload, 'base64url').toString(),
  );
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Unsubscribe token is invalid');
  const claims = parsed as Partial<UnsubscribeClaims>;
  if (
    typeof claims.orgId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(claims.orgId) ||
    typeof claims.accountId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(claims.accountId) ||
    (claims.category !== 'announcement' && claims.category !== 'marketing') ||
    claims.channel !== 'email' ||
    typeof claims.expiresAt !== 'number' ||
    claims.expiresAt < Math.floor(now.getTime() / 1000) ||
    typeof claims.nonce !== 'string'
  )
    throw new Error('Unsubscribe token is expired or invalid');
  return claims as UnsubscribeClaims;
}

function localeContent(campaign: CampaignRow, locale: 'en' | 'es') {
  const variants =
    campaign.locale_variants && typeof campaign.locale_variants === 'object'
      ? (campaign.locale_variants as Record<string, unknown>)
      : {};
  const parsed = localeContentSchema.safeParse(variants[locale]);
  const variant = parsed.success ? parsed.data : null;
  const bodyHtml = variant?.bodyHtml || campaign.body_html || '';
  const bodyText =
    variant?.bodyText || campaign.body_text || htmlToText(bodyHtml);
  return {
    subject: variant?.subject || campaign.subject || '',
    bodyHtml,
    bodyText,
    smsText: variant?.smsText || campaign.sms_text || '',
    pushText:
      variant?.pushText ||
      (typeof variants.__default === 'object' &&
      variants.__default !== null &&
      'pushText' in variants.__default &&
      typeof variants.__default.pushText === 'string'
        ? variants.__default.pushText
        : ''),
  };
}

function nonEmptyAddress(
  channel: string,
  recipient: ResolvedRecipient,
): string | null {
  if (channel === 'email') return recipient.email.toLowerCase() || null;
  if (channel === 'sms')
    return recipient.phoneVerified ? recipient.phoneE164 : null;
  if (channel === 'push') return recipient.accountId;
  return null;
}

async function suppressionKeys(
  trx: OrgTransaction,
  orgId: string,
  channel: string,
  addresses: readonly string[],
): Promise<Set<string>> {
  if (
    !addresses.length ||
    (channel !== 'email' && channel !== 'sms' && channel !== 'push')
  )
    return new Set();
  const rows = await trx
    .selectFrom('suppressions')
    .select('address')
    .where('channel', '=', channel)
    .where('address', 'in', [...addresses])
    .where((eb) => eb.or([eb('org_id', '=', orgId), eb('org_id', 'is', null)]))
    .execute();
  return new Set(rows.map((row) => row.address));
}

async function preferenceMap(
  trx: OrgTransaction,
  orgId: string,
  accountIds: readonly string[],
  category: string,
) {
  if (!accountIds.length) return new Map<string, Map<string, boolean>>();
  const rows = await trx
    .selectFrom('communication_preferences')
    .select(['account_id', 'channel', 'enabled'])
    .where('org_id', '=', orgId)
    .where('account_id', 'in', [...accountIds])
    .where('category', '=', category)
    .execute();
  const result = new Map<string, Map<string, boolean>>();
  for (const row of rows) {
    const values = result.get(row.account_id) ?? new Map<string, boolean>();
    values.set(row.channel, row.enabled);
    result.set(row.account_id, values);
  }
  return result;
}

async function smsConsentMap(
  trx: OrgTransaction,
  orgId: string,
  recipients: readonly ResolvedRecipient[],
): Promise<Set<string>> {
  const accounts = [
    ...new Set(recipients.map((recipient) => recipient.accountId)),
  ];
  const phones = [
    ...new Set(
      recipients.flatMap((recipient) =>
        recipient.phoneE164 ? [recipient.phoneE164] : [],
      ),
    ),
  ];
  if (!accounts.length || !phones.length) return new Set();
  const result = await sql<{
    account_id: string;
    phone_e164: string;
    action: string;
  }>`
    SELECT DISTINCT ON (account_id, phone_e164) account_id, phone_e164, action
    FROM communication_consent_events
    WHERE org_id = ${orgId} AND account_id = ANY(${accounts}::uuid[]) AND phone_e164 = ANY(${phones}::text[])
    ORDER BY account_id, phone_e164, accepted_at DESC, id DESC
  `.execute(trx);
  return new Set(
    result.rows
      .filter((row) => row.action === 'granted')
      .map((row) => `${row.account_id}:${row.phone_e164}`),
  );
}

async function insertDeliveryRows(
  context: OrgContext,
  campaign: CampaignRow,
  recipients: readonly ResolvedRecipient[],
  now: Date,
  runWithOrg: typeof withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const ids = recipients.map((recipient) => recipient.accountId);
    const preferences = await preferenceMap(
      trx,
      context.orgId,
      ids,
      campaign.category,
    );
    const consentedPhones = await smsConsentMap(trx, context.orgId, recipients);
    const values = [] as Array<{
      id: string;
      org_id: string;
      campaign_id: string;
      recipient_account_id: string;
      person_id: string | null;
      channel: string;
      address: string | null;
      status: 'queued' | 'suppressed';
      error: string | null;
    }>;
    const wakeAt = new Map<string, Date>();
    for (const recipient of recipients) {
      for (const channel of campaign.channels) {
        const address = nonEmptyAddress(channel, recipient);
        const enabled = preferences.get(recipient.accountId)?.get(channel);
        const requiresOptIn = campaign.category === 'marketing';
        const isSuppressed =
          address && channel !== 'in_app'
            ? (
                await suppressionKeys(trx, context.orgId, channel, [address])
              ).has(address)
            : false;
        let reason: string | null = null;
        if (!address && channel !== 'in_app')
          reason = 'No verified destination is available';
        else if (enabled === false || (requiresOptIn && enabled !== true))
          reason = 'Recipient preference is disabled';
        else if (isSuppressed) reason = 'Recipient address is suppressed';
        else if (
          channel === 'sms' &&
          (!recipient.phoneE164 ||
            !consentedPhones.has(
              `${recipient.accountId}:${recipient.phoneE164}`,
            ))
        )
          reason = 'SMS consent is not recorded';
        const id = randomUUID();
        values.push({
          id,
          org_id: context.orgId,
          campaign_id: campaign.id,
          recipient_account_id: recipient.accountId,
          person_id: recipient.aboutPersonId,
          channel,
          address,
          status: reason ? 'suppressed' : 'queued',
          error: reason,
        });
        if (!reason) {
          const quiet = quietHoursDecision(
            now.toISOString(),
            recipient.timezone || 'UTC',
            channel as 'email' | 'sms' | 'push' | 'in_app',
            campaign.category === 'emergency',
          );
          if (!quiet.sendNow && quiet.nextSendAt)
            wakeAt.set(id, new Date(quiet.nextSendAt));
        }
      }
    }
    for (const batch of chunk(values, 250)) {
      if (batch.length) {
        await trx
          .insertInto('message_deliveries')
          .values(batch)
          .onConflict((conflict) => conflict.doNothing())
          .execute();
      }
    }
    for (const [id, nextAttemptAt] of wakeAt) {
      await sql`UPDATE message_deliveries SET next_attempt_at = ${nextAttemptAt} WHERE org_id = ${context.orgId} AND id = ${id}`.execute(
        trx,
      );
    }
    await appendAuditEvent(trx, context, {
      action: 'communication.delivery.fanout',
      entityType: 'message_campaign',
      entityId: campaign.id,
      changes: {
        recipient_count: { tier: 'internal', after: recipients.length },
      },
    });
    return values.length;
  });
}

async function addressForMerge(
  context: OrgContext,
  recipient: ResolvedRecipient,
  campaign: CampaignRow,
  runWithOrg: typeof withOrg,
  now: Date,
) {
  return runWithOrg(context, async (trx) => {
    const person = recipient.aboutPersonId
      ? await trx
          .selectFrom('people')
          .select(['first_name', 'preferred_name', 'last_name'])
          .where('org_id', '=', context.orgId)
          .where('id', '=', recipient.aboutPersonId)
          .executeTakeFirst()
      : undefined;
    const audience = audienceSpecSchema.safeParse(campaign.audience);
    const teamSeasonIds = audience.success
      ? (audience.data.include.teamSeasonIds ?? [])
      : [];
    const programIds = audience.success
      ? (audience.data.include.programIds ?? [])
      : [];
    const teamSeasonId = teamSeasonIds[0];
    const programId = programIds[0];
    const team = teamSeasonId
      ? await trx
          .selectFrom('team_seasons as season')
          .innerJoin('teams', (join) =>
            join
              .onRef('teams.id', '=', 'season.team_id')
              .onRef('teams.org_id', '=', 'season.org_id'),
          )
          .innerJoin('programs as program', (join) =>
            join
              .onRef('program.id', '=', 'season.program_id')
              .onRef('program.org_id', '=', 'season.org_id'),
          )
          .select(['teams.name', 'program.name as programName'])
          .where('season.org_id', '=', context.orgId)
          .where('season.id', '=', teamSeasonId)
          .executeTakeFirst()
      : undefined;
    const program = programId
      ? await trx
          .selectFrom('programs')
          .select('name')
          .where('org_id', '=', context.orgId)
          .where('id', '=', programId)
          .executeTakeFirst()
      : undefined;
    const nextEvent = await sql<{ starts_at: Date }>`
      SELECT DISTINCT event.starts_at
      FROM events AS event
      LEFT JOIN event_participants AS participant
        ON participant.org_id = event.org_id AND participant.event_id = event.id
      WHERE event.org_id = ${context.orgId}
        AND event.status = 'scheduled'
        AND event.published = true
        AND event.starts_at > ${now}
        AND (
          (${teamSeasonIds.length > 0} AND participant.team_season_id = ANY(${teamSeasonIds}::uuid[]))
          OR (${programIds.length > 0} AND event.program_id = ANY(${programIds}::uuid[]))
          OR (${recipient.aboutPersonId}::uuid IS NOT NULL AND participant.person_id = ${recipient.aboutPersonId}::uuid)
        )
      ORDER BY event.starts_at
      LIMIT 1
    `.execute(trx);
    const eventStart = nextEvent.rows[0]?.starts_at;
    return {
      'guardian.first_name': recipient.firstName,
      'athlete.first_name': person?.preferred_name || person?.first_name,
      'team.name': team?.name,
      'program.name': program?.name ?? team?.programName,
      'event.next.start': eventStart
        ? new Intl.DateTimeFormat(
            recipient.locale === 'es' ? 'es-US' : 'en-US',
            {
              timeZone: recipient.timezone || 'UTC',
              dateStyle: 'medium',
              timeStyle: 'short',
            },
          ).format(eventStart)
        : undefined,
      'athlete.last_name': person?.last_name,
    };
  });
}

async function orgBranding(context: OrgContext, runWithOrg: typeof withOrg) {
  return runWithOrg(context, async (trx) => {
    const organization = await trx
      .selectFrom('organizations')
      .select(['name', 'address', 'email', 'timezone'])
      .where('id', '=', context.orgId)
      .executeTakeFirstOrThrow();
    const identity = await sql<{
      display_name: string | null;
      reply_to: string | null;
      reply_to_verified_at: Date | null;
      sms_compliance_text: string | null;
    }>`
      SELECT display_name, reply_to, reply_to_verified_at, sms_compliance_text
      FROM communication_sender_identities WHERE org_id = ${context.orgId}
    `.execute(trx);
    const row = identity.rows[0];
    const address =
      organization.address && typeof organization.address === 'object'
        ? (organization.address as Record<string, Json | undefined>)
        : {};
    const physicalAddress = [
      address.line1,
      address.line2,
      address.city,
      address.region,
      address.postalCode,
    ]
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      )
      .join(', ');
    return {
      organizationName: row?.display_name || organization.name,
      replyTo: row?.reply_to_verified_at ? row.reply_to : undefined,
      physicalAddress,
      smsComplianceText: row?.sms_compliance_text ?? null,
    };
  });
}

export async function subscriptionsForAccount(
  context: OrgContext,
  accountId: string,
  runWithOrg: typeof withOrg,
): Promise<Array<{ subscription: PushSubscriptionValue }>> {
  return runWithOrg(context, async (trx) => {
    const rows = await trx
      .selectFrom('device_tokens')
      .select('token_or_subscription')
      .where('account_id', '=', accountId)
      .where('platform', '=', 'webpush')
      .where('revoked_at', 'is', null)
      .execute();
    return rows.flatMap((row) => {
      const parsed =
        row.token_or_subscription as unknown as Partial<PushSubscriptionValue>;
      return typeof parsed.endpoint === 'string' &&
        typeof parsed.keys?.p256dh === 'string' &&
        typeof parsed.keys.auth === 'string'
        ? [{ subscription: parsed as PushSubscriptionValue }]
        : [];
    });
  });
}

async function deliverOne(
  context: OrgContext,
  campaign: CampaignRow,
  recipient: ResolvedRecipient,
  channel: string,
  deliveryId: string,
  dependencies: DeliveryDependencies,
  runWithOrg: typeof withOrg,
) {
  const now = dependencies.now?.() ?? new Date();
  const content = localeContent(campaign, recipient.locale);
  const mergeContext = await addressForMerge(
    context,
    recipient,
    campaign,
    runWithOrg,
    now,
  );
  const html = sanitizeCampaignHtml(
    renderMergeFields(content.bodyHtml, mergeContext, true),
    dependencies.appUrl,
  );
  const plain =
    renderMergeFields(content.bodyText, mergeContext) || htmlToText(html);
  try {
    if (channel === 'email') {
      const branding = await orgBranding(context, runWithOrg);
      if (!branding.physicalAddress)
        throw new Error(
          'Organization physical address is required for email delivery',
        );
      const unsubscribeUrl =
        campaign.category === 'announcement' ||
        campaign.category === 'marketing'
          ? `${dependencies.appUrl.replace(/\/$/, '')}/api/v1/communications/unsubscribe/${createUnsubscribeToken(
              {
                orgId: context.orgId,
                accountId: recipient.accountId,
                category: campaign.category,
                channel: 'email',
                expiresAt: Math.floor(now.getTime() / 1000) + 60 * 60 * 24 * 7,
              },
            )}`
          : null;
      const localizedFooter =
        recipient.locale === 'es'
          ? `<p>${escapeHtmlText(branding.organizationName)} · Este mensaje se envió a una dirección asociada a tu organización.</p><p>${escapeHtmlText(branding.physicalAddress)}</p><p>¿Por qué recibo esto? Eres miembro o tutor de esta organización.</p>`
          : `<p>${escapeHtmlText(branding.organizationName)} · This message was sent to an address associated with your organization.</p><p>${escapeHtmlText(branding.physicalAddress)}</p><p>Why am I getting this? You are a member or guardian in this organization.</p>`;
      const unsubscribeFooter = unsubscribeUrl
        ? `<p><a href="${escapeHtmlText(unsubscribeUrl)}">${recipient.locale === 'es' ? 'Cancelar suscripción a esta categoría' : 'Unsubscribe from this category'}</a></p>`
        : '';
      const wrappedHtml = renderEmailLayout({
        branding: { organizationName: branding.organizationName },
        locale: recipient.locale,
        title: renderMergeFields(content.subject, mergeContext),
        children: ReactMarkup(`${html}${localizedFooter}${unsubscribeFooter}`),
      });
      const result = await dependencies.email.send({
        to: recipient.email,
        subject: renderMergeFields(content.subject, mergeContext),
        text: `${plain}\n\n${htmlToText(localizedFooter)}${unsubscribeUrl ? `\n${unsubscribeUrl}` : ''}`,
        html: wrappedHtml,
        ...(branding.replyTo ? { replyTo: branding.replyTo } : {}),
        headers: { 'X-Athlentry-Delivery-ID': deliveryId },
        kind: 'campaign',
        idempotencyKey: `athlentry:${context.orgId}:${deliveryId}`,
      });
      return { status: 'sent' as const, providerId: result.providerId };
    }
    if (channel === 'sms') {
      const branding = await orgBranding(context, runWithOrg);
      const base = renderMergeFields(content.smsText, mergeContext);
      const compliance =
        branding.smsComplianceText ||
        (recipient.locale === 'es'
          ? 'Responde STOP para cancelar. Responde HELP para obtener ayuda. Pueden aplicarse tarifas de mensajes y datos.'
          : 'Reply STOP to opt out. Reply HELP for help. Msg & data rates may apply.');
      const body = base ? `${base.trim()}\n${compliance}` : compliance;
      if (smsSegmentCount(body) > Math.max(2, smsSegmentCount(base) + 1))
        throw new Error(
          'SMS compliance text would exceed allowed message length',
        );
      const phoneE164 = recipient.phoneE164;
      if (!phoneE164)
        throw new Error('Verified SMS destination is unavailable');
      const result = await dependencies.sms.send({
        to: phoneE164,
        body,
        idempotencyKey: `athlentry:${context.orgId}:${deliveryId}`,
      });
      return { status: 'sent' as const, providerId: result.providerId };
    }
    if (channel === 'push') {
      const subscriptions = await subscriptionsForAccount(
        context,
        recipient.accountId,
        runWithOrg,
      );
      if (!subscriptions.length)
        return {
          status: 'suppressed' as const,
          providerId: null,
          error: 'No active push subscription',
        };
      const message: PushMessage = {
        title: renderMergeFields(
          content.subject || 'Organization message',
          mergeContext,
        ),
        body: renderMergeFields(
          content.pushText || content.bodyText,
          mergeContext,
        ).slice(0, 110),
        url: '/me/messages',
        tag: `campaign-${campaign.id}`,
      };
      let sent = false;
      let providerId: string | null = null;
      for (const { subscription } of subscriptions) {
        const result = await sendPushAndCleanup(
          dependencies.push,
          subscription,
          message,
          {
            removeInvalidEndpoint: async (endpoint) => {
              if (dependencies.removePushSubscription)
                await dependencies.removePushSubscription(endpoint);
              else await removePushEndpoint(context, endpoint, runWithOrg);
            },
          },
        );
        if (result.status === 'sent') {
          sent = true;
          providerId ??= result.providerId ?? null;
        }
      }
      return {
        status: sent ? ('sent' as const) : ('failed' as const),
        providerId,
      };
    }
    if (channel === 'in_app') {
      if (!dependencies.notifications)
        throw new Error('Track B notifications service is not mounted');
      const notificationId = await dependencies.notifications({
        context,
        accountId: recipient.accountId,
        type:
          campaign.category === 'emergency'
            ? 'communications.emergency'
            : 'communications.campaign',
        payload: { campaignId: campaign.id, deliveryId },
      });
      return { status: 'sent' as const, providerId: null, notificationId };
    }
    throw new RangeError('Delivery channel is invalid');
  } catch (error) {
    return {
      status: 'failed' as const,
      providerId: null,
      error:
        error instanceof Error
          ? error.message.slice(0, 300)
          : 'Delivery failed',
    };
  }
}

// Keep markup insertion at the React Email boundary. The HTML is rebuilt by
// the server-side allow-list sanitizer before reaching this renderer.
function ReactMarkup(html: string): React.ReactElement {
  return React.createElement('div', {
    dangerouslySetInnerHTML: { __html: html },
  });
}

export async function removePushEndpoint(
  context: OrgContext,
  endpoint: string,
  runWithOrg: typeof withOrg,
) {
  await runWithOrg(context, async (trx) => {
    await sql`UPDATE device_tokens SET revoked_at = now(), token_or_subscription = '{}'::jsonb WHERE platform = 'webpush' AND revoked_at IS NULL AND token_or_subscription->>'endpoint' = ${endpoint}`.execute(
      trx,
    );
  });
}

async function transitionDelivery(
  context: OrgContext,
  deliveryId: string,
  outcome: Awaited<ReturnType<typeof deliverOne>>,
  now: Date,
  runWithOrg: typeof withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const existingResult = await sql<{
      attempt_count: number;
      status: string;
      channel: string;
    }>`SELECT attempt_count, status, channel FROM message_deliveries WHERE org_id = ${context.orgId} AND id = ${deliveryId}`.execute(
      trx,
    );
    const existing = existingResult.rows[0];
    if (!existing || existing.status !== 'sending') return;
    if (outcome.status === 'sent') {
      await sql`UPDATE message_deliveries SET status = 'sent', provider_message_id = ${outcome.providerId}, sent_at = ${now}, delivered_at = NULL, error = NULL, next_attempt_at = NULL, version = version + 1 WHERE org_id = ${context.orgId} AND id = ${deliveryId} AND status = 'sending'`.execute(
        trx,
      );
      if (
        outcome.providerId &&
        (existing.channel === 'email' || existing.channel === 'sms')
      ) {
        await sql`INSERT INTO provider_delivery_keys(channel, provider_id, tenant_org_id, delivery_id) VALUES (${existing.channel}, ${outcome.providerId}, ${context.orgId}, ${deliveryId}) ON CONFLICT (channel, provider_id) DO NOTHING`.execute(
          trx,
        );
      }
      if ('notificationId' in outcome && outcome.notificationId) {
        await sql`UPDATE message_deliveries SET notification_id = ${outcome.notificationId} WHERE org_id = ${context.orgId} AND id = ${deliveryId}`.execute(
          trx,
        );
      }
      return;
    }
    if (outcome.status === 'suppressed') {
      await sql`UPDATE message_deliveries SET status = 'suppressed', error = ${outcome.error}, next_attempt_at = NULL, version = version + 1 WHERE org_id = ${context.orgId} AND id = ${deliveryId}`.execute(
        trx,
      );
      return;
    }
    const attempts = existing.attempt_count;
    const retryAt =
      attempts < 5
        ? new Date(now.getTime() + 60_000 * 2 ** (attempts - 1))
        : null;
    await sql`UPDATE message_deliveries SET status = 'failed', last_attempt_at = ${now}, next_attempt_at = ${retryAt}, error = ${outcome.error ?? 'Delivery failed'}, version = version + 1 WHERE org_id = ${context.orgId} AND id = ${deliveryId}`.execute(
      trx,
    );
  });
}

export async function sendCampaign(
  context: OrgContext,
  campaignId: string,
  expectedVersion: number,
  dependencies: DeliveryDependencies,
  options: {
    confirmEmergency?: boolean;
    now?: Date;
    runWithOrg?: typeof withOrg;
  } = {},
) {
  const runWithOrg = options.runWithOrg ?? withOrg;
  const now = options.now ?? dependencies.now?.() ?? new Date();
  const campaign = await getCampaignForDelivery(
    context,
    campaignId,
    runWithOrg,
  );
  if (campaign.category === 'emergency' && !options.confirmEmergency)
    throw new CommunicationsAccessError(
      'Emergency send requires explicit confirmation',
    );
  const parsedAudience = audienceSpecSchema.parse(campaign.audience);
  const recipients = await resolveAudience(
    context,
    parsedAudience,
    now,
    runWithOrg,
  );
  const marked = await markCampaignSending(
    context,
    campaignId,
    expectedVersion,
    recipients.length,
    now,
    runWithOrg,
  );
  await insertDeliveryRows(context, marked, recipients, now, runWithOrg);
  const deliveries = await runWithOrg(context, async (trx) =>
    sql<{
      id: string;
      recipient_account_id: string;
      channel: string;
    }>`SELECT id, recipient_account_id, channel FROM message_deliveries WHERE org_id = ${context.orgId} AND campaign_id = ${campaignId} AND status IN ('queued', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}) ORDER BY created_at LIMIT 5000`
      .execute(trx)
      .then((result) => result.rows),
  );
  const recipientsById = new Map(
    recipients.map((recipient) => [recipient.accountId, recipient]),
  );
  for (const delivery of deliveries) {
    const recipient = recipientsById.get(delivery.recipient_account_id);
    if (!recipient) continue;
    const attempt = await runWithOrg(context, async (trx) => {
      const result = await trx.executeQuery<{
        id: string;
        attempt_count: number;
      }>(
        sql<{ id: string; attempt_count: number }>`
        UPDATE message_deliveries SET status = 'sending', attempt_count = attempt_count + 1, last_attempt_at = ${now}, version = version + 1
        WHERE org_id = ${context.orgId} AND id = ${delivery.id} AND status IN ('queued', 'failed')
          AND attempt_count < 5 AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        RETURNING id, attempt_count
      `.compile(trx),
      );
      return result.rows[0];
    });
    if (!attempt) continue;
    const outcome = await deliverOne(
      context,
      marked,
      recipient,
      delivery.channel,
      delivery.id,
      dependencies,
      runWithOrg,
    );
    await transitionDelivery(context, delivery.id, outcome, now, runWithOrg);
  }
  const stillOpen = await runWithOrg(context, async (trx) =>
    sql<{ id: string }>`
    SELECT id FROM message_deliveries WHERE org_id = ${context.orgId} AND campaign_id = ${campaignId}
      AND (status IN ('queued', 'sending') OR (status = 'failed' AND attempt_count < 5)) LIMIT 1
  `
      .execute(trx)
      .then((result) => result.rows[0]),
  );
  if (!stillOpen) {
    const terminalFailures = await runWithOrg(context, async (trx) =>
      sql<{ count: number }>`
      SELECT count(*)::int AS count FROM message_deliveries WHERE org_id = ${context.orgId} AND campaign_id = ${campaignId} AND status = 'failed'
    `
        .execute(trx)
        .then((result) => result.rows[0]?.count ?? 0),
    );
    await markCampaignFinished(
      context,
      campaignId,
      terminalFailures > 0,
      now,
      runWithOrg,
    );
  }
  return {
    campaignId,
    recipientCount: recipients.length,
    openDeliveries: Boolean(stillOpen),
  };
}

export async function runScheduledCampaign(
  context: OrgContext,
  campaignId: string,
  dependencies: DeliveryDependencies,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const campaign = await getCampaignForDelivery(
    context,
    campaignId,
    runWithOrg,
  );
  if (
    campaign.status !== 'scheduled' ||
    !campaign.scheduled_for ||
    campaign.scheduled_for > now
  )
    return null;
  return sendCampaign(context, campaignId, campaign.version, dependencies, {
    now,
    runWithOrg,
    confirmEmergency: campaign.category === 'emergency',
  });
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    chunks.push(values.slice(index, index + size));
  return chunks;
}

export async function sendCampaignTest(
  context: OrgContext,
  campaignId: string,
  dependencies: DeliveryDependencies,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const campaign = await getCampaignForDelivery(
    context,
    campaignId,
    runWithOrg,
  );
  const recipient = await runWithOrg(context, async (trx) => {
    const row = await trx
      .selectFrom('accounts')
      .select([
        'id',
        'first_name',
        'last_name',
        'email',
        'phone_e164',
        'phone_verified_at',
        'locale',
        'timezone',
      ])
      .where('id', '=', context.actor.accountId)
      .executeTakeFirstOrThrow();
    return {
      accountId: row.id,
      aboutPersonId: null,
      firstName: row.first_name,
      displayName: `${row.first_name} ${row.last_name}`,
      locale: row.locale === 'es' ? ('es' as const) : ('en' as const),
      email: row.email,
      phoneE164: row.phone_e164,
      phoneVerified: row.phone_verified_at !== null,
      timezone: row.timezone ?? 'UTC',
    };
  });
  const preferences = await runWithOrg(context, (trx) =>
    preferenceMap(trx, context.orgId, [recipient.accountId], campaign.category),
  );
  const consented = campaign.channels.includes('sms')
    ? await runWithOrg(context, (trx) =>
        smsConsentMap(trx, context.orgId, [recipient]),
      )
    : new Set<string>();
  const results: Array<{ channel: string; status: string }> = [];
  for (const channel of campaign.channels) {
    if (
      channel === 'sms' &&
      (!recipient.phoneVerified ||
        !recipient.phoneE164 ||
        !consented.has(`${recipient.accountId}:${recipient.phoneE164}`))
    ) {
      results.push({ channel, status: 'skipped' });
      continue;
    }
    if (
      channel !== 'in_app' &&
      (
        await runWithOrg(context, (trx) =>
          suppressionKeys(trx, context.orgId, channel, [
            nonEmptyAddress(channel, recipient) ?? '',
          ]),
        )
      ).size
    ) {
      results.push({ channel, status: 'skipped' });
      continue;
    }
    const preference = preferences.get(recipient.accountId)?.get(channel);
    if (
      preference === false ||
      (campaign.category === 'marketing' && preference !== true)
    ) {
      results.push({ channel, status: 'skipped' });
      continue;
    }
    const quiet = quietHoursDecision(
      now.toISOString(),
      recipient.timezone || 'UTC',
      channel as 'email' | 'sms' | 'push' | 'in_app',
      campaign.category === 'emergency',
    );
    if (!quiet.sendNow) {
      results.push({ channel, status: 'skipped_quiet_hours' });
      continue;
    }
    const outcome = await deliverOne(
      context,
      campaign,
      recipient,
      channel,
      randomUUID(),
      dependencies,
      runWithOrg,
    );
    results.push({ channel, status: outcome.status });
  }
  return { testedAt: now.toISOString(), results };
}

export async function recordWebhookStatus(
  context: OrgContext,
  providerMessageId: string,
  channel: 'email' | 'sms',
  status: string,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const emailStatuses: Record<string, string> = {
    'email.delivered': 'delivered',
    'email.bounced': 'bounced',
    'email.complained': 'complained',
    'email.opened': 'opened',
    'email.clicked': 'clicked',
  };
  const smsStatuses: Record<string, string> = {
    queued: 'queued',
    accepted: 'sent',
    sending: 'sent',
    sent: 'sent',
    delivered: 'delivered',
    failed: 'failed',
    undelivered: 'failed',
  };
  const mapped = (channel === 'email' ? emailStatuses : smsStatuses)[status];
  if (!mapped) throw new RangeError('Delivery webhook status is unsupported');
  return runWithOrg(context, async (trx) => {
    const delivery = await trx
      .selectFrom('message_deliveries')
      .select(['id', 'address', 'campaign_id', 'status'])
      .where('org_id', '=', context.orgId)
      .where('channel', '=', channel)
      .where('provider_message_id', '=', providerMessageId)
      .executeTakeFirst();
    if (!delivery || !delivery.campaign_id)
      throw new Error('Campaign delivery not found');
    const current = delivery.status;
    const priority: Record<string, number> = {
      queued: 0,
      sending: 1,
      sent: 2,
      delivered: 3,
      opened: 4,
      clicked: 5,
      bounced: 4,
      complained: 5,
      failed: 4,
      suppressed: 6,
    };
    if (
      mapped === current ||
      (priority[mapped] ?? 0) < (priority[current] ?? 0) ||
      current === 'complained' ||
      current === 'bounced'
    )
      return delivery.id;
    const timestampField =
      mapped === 'delivered'
        ? 'delivered_at'
        : mapped === 'opened'
          ? 'opened_at'
          : mapped === 'clicked'
            ? 'clicked_at'
            : null;
    await trx
      .updateTable('message_deliveries')
      .set({
        status: mapped,
        ...(timestampField === 'delivered_at' ? { delivered_at: now } : {}),
        ...(timestampField === 'opened_at' ? { opened_at: now } : {}),
        ...(timestampField === 'clicked_at' ? { clicked_at: now } : {}),
        version: sql`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', delivery.id)
      .execute();
    if ((mapped === 'bounced' || mapped === 'complained') && delivery.address) {
      await trx
        .insertInto('suppressions')
        .values({
          id: randomUUID(),
          org_id: context.orgId,
          channel,
          address: delivery.address,
          reason: mapped === 'bounced' ? 'bounce' : 'complaint',
        })
        .onConflict((conflict) =>
          conflict.columns(['org_id', 'channel', 'address']).doNothing(),
        )
        .execute();
    }
    await appendAuditEvent(trx, context, {
      action: 'communication.delivery.webhook',
      entityType: 'message_delivery',
      entityId: delivery.id,
      changes: { status: { tier: 'internal', before: current, after: mapped } },
    });
    return delivery.id;
  });
}

export async function deliverDueCampaigns(
  dependencies: DeliveryDependencies,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const database = getDatabase();
  const orgs = await database
    .selectFrom('organizations')
    .select('id')
    .where('status', '=', 'active')
    .execute();
  const results = [];
  for (const org of orgs) {
    const campaigns = await runWithOrg(
      {
        orgId: org.id,
        actor: { accountId: '00000000-0000-0000-0000-000000000000' },
      },
      async (trx) =>
        trx
          .selectFrom('message_campaigns')
          .select(['org_id', 'id', 'author_account_id', 'status'])
          .where('org_id', '=', org.id)
          .where('status', 'in', ['scheduled', 'sending'])
          .where((eb) =>
            eb.or([
              eb.and([
                eb('status', '=', 'scheduled'),
                eb('scheduled_for', '<=', now),
              ]),
              eb('status', '=', 'sending'),
            ]),
          )
          .orderBy('scheduled_for')
          .limit(100)
          .execute(),
    );
    for (const campaign of campaigns) {
      const context = {
        orgId: campaign.org_id,
        actor: { accountId: campaign.author_account_id },
      };
      try {
        results.push(
          campaign.status === 'scheduled'
            ? await runScheduledCampaign(
                context,
                campaign.id,
                dependencies,
                now,
                runWithOrg,
              )
            : await retryCampaign(
                context,
                campaign.id,
                dependencies,
                now,
                runWithOrg,
              ),
        );
      } catch {
        results.push(null);
      }
    }
  }
  return results;
}

export async function retryCampaign(
  context: OrgContext,
  campaignId: string,
  dependencies: DeliveryDependencies,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const campaign = await getCampaignForDelivery(
    context,
    campaignId,
    runWithOrg,
  );
  if (campaign.status !== 'sending') return null;
  const audience = audienceSpecSchema.parse(campaign.audience);
  const recipients = await resolveAudience(context, audience, now, runWithOrg);
  const recipientById = new Map(
    recipients.map((recipient) => [recipient.accountId, recipient]),
  );
  const pending = await runWithOrg(context, async (trx) =>
    sql<{ id: string; recipient_account_id: string; channel: string }>`
    SELECT id, recipient_account_id, channel FROM message_deliveries
    WHERE org_id = ${context.orgId} AND campaign_id = ${campaignId}
      AND status IN ('queued', 'failed') AND attempt_count < 5
      AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
    LIMIT 5000
  `
      .execute(trx)
      .then((result) => result.rows),
  );
  for (const delivery of pending) {
    const recipient = recipientById.get(delivery.recipient_account_id);
    if (!recipient) continue;
    const claimed = await runWithOrg(context, async (trx) => {
      const result = await trx.executeQuery<{ id: string }>(
        sql<{ id: string }>`
        UPDATE message_deliveries SET status = 'sending', attempt_count = attempt_count + 1, last_attempt_at = ${now}, version = version + 1
        WHERE org_id = ${context.orgId} AND id = ${delivery.id} AND status IN ('queued', 'failed') AND attempt_count < 5
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}) RETURNING id
      `.compile(trx),
      );
      return result.rows[0];
    });
    if (!claimed) continue;
    const outcome = await deliverOne(
      context,
      campaign,
      recipient,
      delivery.channel,
      delivery.id,
      dependencies,
      runWithOrg,
    );
    await transitionDelivery(context, delivery.id, outcome, now, runWithOrg);
  }
  const remaining = await runWithOrg(context, async (trx) =>
    sql<{ id: string }>`
    SELECT id FROM message_deliveries WHERE org_id = ${context.orgId} AND campaign_id = ${campaignId}
      AND (status IN ('queued', 'sending') OR (status = 'failed' AND attempt_count < 5)) LIMIT 1
  `
      .execute(trx)
      .then((result) => result.rows[0]),
  );
  if (!remaining) {
    const terminalFailures = await runWithOrg(context, async (trx) =>
      sql<{ count: number }>`
      SELECT count(*)::int AS count FROM message_deliveries WHERE org_id = ${context.orgId} AND campaign_id = ${campaignId} AND status = 'failed'
    `
        .execute(trx)
        .then((result) => result.rows[0]?.count ?? 0),
    );
    await markCampaignFinished(
      context,
      campaignId,
      terminalFailures > 0,
      now,
      runWithOrg,
    );
  }
  return { campaignId, openDeliveries: Boolean(remaining) };
}
