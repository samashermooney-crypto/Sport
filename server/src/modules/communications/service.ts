import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';

import { resolveAudience } from './audience';
import type { ResolvedRecipient } from './audience';
import { htmlToText, sanitizeCampaignHtml } from './content';
import type {
  AudienceSpec,
  CampaignDraft,
  CommunicationCategory,
  DeliveryChannel,
} from './schema';
import {
  audienceOptionsSchema,
  campaignAudiencePreviewSchema,
  campaignDraftSchema,
  campaignSummarySchema,
} from './schema';

export class CommunicationsAccessError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
}
export class CommunicationsPermissionError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
}
export class CommunicationsConflictError extends Error {
  readonly status = 409;
  readonly code = 'CONFLICT';
}

const campaignRoles = ['owner', 'admin', 'communications', 'director'] as const;
const emergencyRoles = ['owner', 'admin'] as const;

export async function requireCommunicationsRole(
  trx: OrgTransaction,
  context: OrgContext,
  emergency = false,
): Promise<void> {
  const member = await trx
    .selectFrom('org_memberships')
    .select('status')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .executeTakeFirst();
  if (member?.status !== 'active')
    throw new CommunicationsAccessError('Communications not found');
  const roles = emergency ? emergencyRoles : campaignRoles;
  const assignment = await trx
    .selectFrom('role_assignments')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('scope_type', '=', 'org')
    .where('role', 'in', [...roles])
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .executeTakeFirst();
  if (!assignment)
    throw new CommunicationsPermissionError(
      'Communications access is required',
    );
}

export type CampaignRow = {
  id: string;
  org_id: string;
  author_account_id: string;
  channels: string[];
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  sms_text: string | null;
  locale_variants: Json;
  audience: Json;
  category: string;
  status: string;
  scheduled_for: Date | null;
  sent_at: Date | null;
  resolved_recipient_count: number | null;
  reply_to: string | null;
  version: number;
  created_at: Date;
};

function summary(row: CampaignRow) {
  return campaignSummarySchema.parse({
    id: row.id,
    status: row.status,
    category: row.category,
    channels: row.channels,
    subject: row.subject,
    scheduledFor: row.scheduled_for?.toISOString() ?? null,
    sentAt: row.sent_at?.toISOString() ?? null,
    resolvedRecipientCount: row.resolved_recipient_count,
    version: row.version,
    createdAt: row.created_at.toISOString(),
  });
}

async function requiredCampaign(
  trx: OrgTransaction,
  context: OrgContext,
  campaignId: string,
): Promise<CampaignRow> {
  const campaign = await trx
    .selectFrom('message_campaigns')
    .selectAll()
    .where('org_id', '=', context.orgId)
    .where('id', '=', campaignId)
    .executeTakeFirst();
  if (!campaign) throw new CommunicationsAccessError('Campaign not found');
  return campaign;
}

function storedContent(
  input: CampaignDraft,
  appUrl: string,
): {
  input: CampaignDraft;
  defaultHtml: string;
  defaultText: string;
  defaultLocaleVariants: Json;
} {
  const parsed = campaignDraftSchema.parse(input);
  const defaultHtml = sanitizeCampaignHtml(parsed.bodyHtml, appUrl);
  const defaultText = parsed.bodyText.trim() || htmlToText(defaultHtml);
  const variants = {
    en: {
      ...parsed.localeVariants.en,
      bodyHtml: sanitizeCampaignHtml(parsed.localeVariants.en.bodyHtml, appUrl),
    },
    es: {
      ...parsed.localeVariants.es,
      bodyHtml: sanitizeCampaignHtml(parsed.localeVariants.es.bodyHtml, appUrl),
    },
  };
  return {
    input: parsed,
    defaultHtml,
    defaultText,
    defaultLocaleVariants: {
      ...variants,
      __default: { pushText: parsed.pushText },
    },
  };
}

export async function listCampaigns(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireCommunicationsRole(trx, context);
    const rows = await trx
      .selectFrom('message_campaigns')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return { items: rows.map((row) => summary(row as CampaignRow)) };
  });
}

export async function listAudienceOptions(
  context: OrgContext,
  query = '',
  runWithOrg: typeof withOrg = withOrg,
) {
  const needle = query.trim().slice(0, 80);
  return runWithOrg(context, async (trx) => {
    await requireCommunicationsRole(trx, context);
    const peopleQuery = trx
      .selectFrom('people')
      .select(['id', 'first_name', 'last_name', 'preferred_name'])
      .where('org_id', '=', context.orgId)
      .where('status', '=', 'active');
    const people = needle
      ? await peopleQuery
          .where((eb) =>
            eb.or([
              eb('first_name', 'ilike', `%${needle}%`),
              eb('last_name', 'ilike', `%${needle}%`),
              eb('preferred_name', 'ilike', `%${needle}%`),
            ]),
          )
          .orderBy('last_name')
          .orderBy('first_name')
          .limit(100)
          .execute()
      : await peopleQuery
          .orderBy('last_name')
          .orderBy('first_name')
          .limit(100)
          .execute();
    const teamQuery = trx
      .selectFrom('team_seasons as season')
      .innerJoin('teams as team', (join) =>
        join
          .onRef('team.id', '=', 'season.team_id')
          .onRef('team.org_id', '=', 'season.org_id'),
      )
      .innerJoin('programs as program', (join) =>
        join
          .onRef('program.id', '=', 'season.program_id')
          .onRef('program.org_id', '=', 'season.org_id'),
      )
      .select([
        'season.id',
        'season.display_name',
        'team.name as team_name',
        'program.name as program_name',
      ])
      .where('season.org_id', '=', context.orgId)
      .where('season.status', '=', 'active');
    const teams = needle
      ? await teamQuery
          .where((eb) =>
            eb.or([
              eb('season.display_name', 'ilike', `%${needle}%`),
              eb('team.name', 'ilike', `%${needle}%`),
              eb('program.name', 'ilike', `%${needle}%`),
            ]),
          )
          .orderBy('team.name')
          .limit(100)
          .execute()
      : await teamQuery.orderBy('team.name').limit(100).execute();
    const programQuery = trx
      .selectFrom('programs')
      .select(['id', 'name', 'season_id'])
      .where('org_id', '=', context.orgId)
      .where('status', '=', 'active');
    const programs = needle
      ? await programQuery
          .where('name', 'ilike', `%${needle}%`)
          .orderBy('name')
          .limit(100)
          .execute()
      : await programQuery.orderBy('name').limit(100).execute();
    return audienceOptionsSchema.parse({
      people: people.map((person) => ({
        id: person.id,
        label:
          `${person.preferred_name || person.first_name} ${person.last_name}`.trim(),
      })),
      teams: teams.map((team) => ({
        id: team.id,
        label: `${team.display_name || team.team_name} · ${team.program_name}`,
      })),
      programs: programs.map((program) => ({
        id: program.id,
        label: program.name,
      })),
    });
  });
}

export async function getCampaignDetail(
  context: OrgContext,
  campaignId: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireCommunicationsRole(trx, context);
    const row = await requiredCampaign(trx, context, campaignId);
    const variants =
      row.locale_variants && typeof row.locale_variants === 'object'
        ? (row.locale_variants as Record<string, unknown>)
        : {};
    const localeVariants = {
      en: variants.en ?? {},
      es: variants.es ?? {},
    };
    const defaults =
      variants.__default && typeof variants.__default === 'object'
        ? (variants.__default as Record<string, unknown>)
        : {};
    return {
      ...summary(row),
      draft: campaignDraftSchema.parse({
        channels: row.channels,
        category: row.category,
        audience: row.audience,
        subject: row.subject ?? '',
        bodyHtml: row.body_html ?? '',
        bodyText: row.body_text ?? '',
        smsText: row.sms_text ?? '',
        pushText:
          typeof defaults.pushText === 'string' ? defaults.pushText : '',
        localeVariants,
      }),
    };
  });
}

export async function createCampaign(
  context: OrgContext,
  input: CampaignDraft,
  appUrl: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  const content = storedContent(input, appUrl);
  return runWithOrg(context, async (trx) => {
    await requireCommunicationsRole(
      trx,
      context,
      content.input.category === 'emergency',
    );
    const id = randomUUID();
    const row = await trx
      .insertInto('message_campaigns')
      .values({
        id,
        org_id: context.orgId,
        author_account_id: context.actor.accountId,
        channels: content.input.channels,
        category: content.input.category,
        audience: content.input.audience as unknown as Json,
        subject: content.input.subject || null,
        body_html: content.defaultHtml || null,
        body_text: content.defaultText || null,
        sms_text: content.input.smsText || null,
        locale_variants: content.defaultLocaleVariants,
        status: 'draft',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendAuditEvent(trx, context, {
      action: 'communication.campaign.create',
      entityType: 'message_campaign',
      entityId: id,
      changes: {
        category: { tier: 'internal', after: content.input.category },
        channels: { tier: 'internal', after: content.input.channels },
        audience: { tier: 'internal', after: '[configured]' },
      },
    });
    return summary(row);
  });
}

export async function updateCampaign(
  context: OrgContext,
  campaignId: string,
  input: CampaignDraft,
  expectedVersion: number,
  appUrl: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  const content = storedContent(input, appUrl);
  return runWithOrg(context, async (trx) => {
    await requireCommunicationsRole(
      trx,
      context,
      content.input.category === 'emergency',
    );
    const current = await requiredCampaign(trx, context, campaignId);
    if (
      current.version !== expectedVersion ||
      !['draft', 'scheduled'].includes(current.status)
    )
      throw new CommunicationsConflictError(
        'Campaign changed or can no longer be edited',
      );
    const row = await trx
      .updateTable('message_campaigns')
      .set({
        channels: content.input.channels,
        category: content.input.category,
        audience: content.input.audience as unknown as Json,
        subject: content.input.subject || null,
        body_html: content.defaultHtml || null,
        body_text: content.defaultText || null,
        sms_text: content.input.smsText || null,
        locale_variants: content.defaultLocaleVariants,
        status: 'draft',
        scheduled_for: null,
        version: current.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', campaignId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!row)
      throw new CommunicationsConflictError('Campaign version is stale');
    await appendAuditEvent(trx, context, {
      action: 'communication.campaign.update',
      entityType: 'message_campaign',
      entityId: campaignId,
      changes: {
        version: {
          tier: 'internal',
          before: expectedVersion,
          after: row.version,
        },
      },
    });
    return summary(row);
  });
}

async function previewAudience(
  context: OrgContext,
  audience: AudienceSpec,
  category: CommunicationCategory,
  channels: DeliveryChannel[],
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const recipients = await resolveAudience(context, audience, now, runWithOrg);
  const eligibility = await runWithOrg(context, async (trx) => {
    const accountIds = [
      ...new Set(recipients.map((recipient) => recipient.accountId)),
    ];
    const preferences = accountIds.length
      ? await trx
          .selectFrom('communication_preferences')
          .select(['account_id', 'channel', 'enabled'])
          .where('org_id', '=', context.orgId)
          .where('account_id', 'in', accountIds)
          .where('category', '=', category)
          .execute()
      : [];
    const preferenceMap = new Map(
      preferences.map((entry) => [
        `${entry.account_id}:${entry.channel}`,
        entry.enabled,
      ]),
    );
    const addresses = {
      email: [
        ...new Set(
          recipients
            .map((recipient) => recipient.email.toLowerCase())
            .filter(Boolean),
        ),
      ],
      sms: [
        ...new Set(
          recipients
            .map((recipient) => recipient.phoneE164)
            .filter((value): value is string => Boolean(value)),
        ),
      ],
      push: accountIds,
    };
    const suppressions = new Set<string>();
    for (const channel of ['email', 'sms', 'push'] as const) {
      const items = addresses[channel];
      if (!items.length) continue;
      const rows = await trx
        .selectFrom('suppressions')
        .select(['channel', 'address'])
        .where('channel', '=', channel)
        .where('address', 'in', items)
        .where((eb) =>
          eb.or([eb('org_id', '=', context.orgId), eb('org_id', 'is', null)]),
        )
        .execute();
      for (const row of rows) suppressions.add(`${row.channel}:${row.address}`);
    }
    const smsConsent = new Set<string>();
    if (accountIds.length && addresses.sms.length) {
      const rows = await sql<{
        account_id: string;
        phone_e164: string;
        action: string;
      }>`
        SELECT DISTINCT ON (account_id, phone_e164) account_id, phone_e164, action FROM communication_consent_events
        WHERE org_id = ${context.orgId} AND account_id = ANY(${accountIds}::uuid[]) AND phone_e164 = ANY(${addresses.sms}::text[])
        ORDER BY account_id, phone_e164, accepted_at DESC, id DESC
      `.execute(trx);
      for (const row of rows.rows)
        if (row.action === 'granted')
          smsConsent.add(`${row.account_id}:${row.phone_e164}`);
    }
    const pushIds = accountIds.length
      ? await trx
          .selectFrom('device_tokens')
          .select('account_id')
          .where('platform', '=', 'webpush')
          .where('revoked_at', 'is', null)
          .where('account_id', 'in', accountIds)
          .execute()
      : [];
    const pushAccounts = new Set(pushIds.map((item) => item.account_id));
    const channelsFor = (recipient: ResolvedRecipient) =>
      channels.filter((channel) => {
        const configured = preferenceMap.get(
          `${recipient.accountId}:${channel}`,
        );
        if (
          configured === false ||
          (category === 'marketing' && configured !== true)
        )
          return false;
        if (channel === 'email')
          return (
            Boolean(recipient.email) &&
            !suppressions.has(`email:${recipient.email.toLowerCase()}`)
          );
        if (channel === 'sms')
          return Boolean(
            recipient.phoneE164 &&
            recipient.phoneVerified &&
            smsConsent.has(`${recipient.accountId}:${recipient.phoneE164}`) &&
            !suppressions.has(`sms:${recipient.phoneE164}`),
          );
        if (channel === 'push')
          return (
            pushAccounts.has(recipient.accountId) &&
            !suppressions.has(`push:${recipient.accountId}`)
          );
        return true;
      });
    return { channelsFor };
  });
  const visibleRecipients = recipients.slice(0, 50).map((recipient) => ({
    displayName: recipient.displayName,
    locale: recipient.locale,
    aboutPersonId: recipient.aboutPersonId,
    channels: eligibility.channelsFor(recipient),
  }));
  const counts = Object.fromEntries(
    channels.map((channel) => [
      channel,
      recipients.filter((recipient) =>
        eligibility.channelsFor(recipient).includes(channel),
      ).length,
    ]),
  );
  return {
    recipientCount: recipients.length,
    counts,
    recipients: visibleRecipients,
  };
}

export async function previewCampaign(
  context: OrgContext,
  campaignId: string,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const campaign = await runWithOrg(context, async (trx) => {
    const row = await requiredCampaign(trx, context, campaignId);
    await requireCommunicationsRole(trx, context, row.category === 'emergency');
    return row;
  });
  return previewAudience(
    context,
    campaign.audience as unknown as AudienceSpec,
    campaign.category as CommunicationCategory,
    campaign.channels as DeliveryChannel[],
    now,
    runWithOrg,
  );
}

export async function previewCampaignDraft(
  context: OrgContext,
  input: {
    audience: AudienceSpec;
    category: CommunicationCategory;
    channels: DeliveryChannel[];
  },
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const parsed = campaignAudiencePreviewSchema.parse(input);
  await runWithOrg(context, async (trx) => {
    await requireCommunicationsRole(
      trx,
      context,
      parsed.category === 'emergency',
    );
  });
  return previewAudience(
    context,
    parsed.audience,
    parsed.category,
    parsed.channels,
    now,
    runWithOrg,
  );
}

export async function scheduleCampaign(
  context: OrgContext,
  campaignId: string,
  scheduledFor: Date,
  expectedVersion: number,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  if (scheduledFor <= now)
    throw new RangeError('Scheduled time must be in the future');
  return runWithOrg(context, async (trx) => {
    const current = await requiredCampaign(trx, context, campaignId);
    await requireCommunicationsRole(
      trx,
      context,
      current.category === 'emergency',
    );
    if (current.version !== expectedVersion || current.status !== 'draft')
      throw new CommunicationsConflictError(
        'Campaign changed or cannot be scheduled',
      );
    const row = await trx
      .updateTable('message_campaigns')
      .set({
        status: 'scheduled',
        scheduled_for: scheduledFor,
        version: expectedVersion + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', campaignId)
      .where('version', '=', expectedVersion)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    if (!row)
      throw new CommunicationsConflictError('Campaign version is stale');
    await appendAuditEvent(trx, context, {
      action: 'communication.campaign.schedule',
      entityType: 'message_campaign',
      entityId: campaignId,
      changes: {
        scheduled_for: { tier: 'internal', after: scheduledFor.toISOString() },
      },
    });
    return summary(row);
  });
}

export async function cancelCampaign(
  context: OrgContext,
  campaignId: string,
  expectedVersion: number,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const current = await requiredCampaign(trx, context, campaignId);
    await requireCommunicationsRole(
      trx,
      context,
      current.category === 'emergency',
    );
    if (current.version !== expectedVersion || current.status !== 'scheduled')
      throw new CommunicationsConflictError(
        'Campaign changed or cannot be canceled',
      );
    const row = await trx
      .updateTable('message_campaigns')
      .set({ status: 'canceled', version: expectedVersion + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', campaignId)
      .where('version', '=', expectedVersion)
      .where('status', '=', 'scheduled')
      .returningAll()
      .executeTakeFirst();
    if (!row)
      throw new CommunicationsConflictError('Campaign version is stale');
    await appendAuditEvent(trx, context, {
      action: 'communication.campaign.cancel',
      entityType: 'message_campaign',
      entityId: campaignId,
      changes: {
        status: { tier: 'internal', before: 'scheduled', after: 'canceled' },
      },
    });
    return summary(row);
  });
}

export async function getCampaignForDelivery(
  context: OrgContext,
  campaignId: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, (trx) =>
    requiredCampaign(trx, context, campaignId),
  );
}

export async function markCampaignSending(
  context: OrgContext,
  campaignId: string,
  expectedVersion: number,
  recipientCount: number,
  now: Date,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const row = await trx
      .updateTable('message_campaigns')
      .set({
        status: 'sending',
        resolved_recipient_count: recipientCount,
        version: expectedVersion + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', campaignId)
      .where('version', '=', expectedVersion)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'draft'),
          eb.and([
            eb('status', '=', 'scheduled'),
            eb('scheduled_for', '<=', now),
          ]),
        ]),
      )
      .returningAll()
      .executeTakeFirst();
    if (!row)
      throw new CommunicationsConflictError('Campaign changed or is not due');
    await appendAuditEvent(trx, context, {
      action: 'communication.campaign.send',
      entityType: 'message_campaign',
      entityId: campaignId,
      changes: {
        status: { tier: 'internal', before: 'draft', after: 'sending' },
      },
    });
    return row;
  });
}

export async function markCampaignFinished(
  context: OrgContext,
  campaignId: string,
  failed: boolean,
  now: Date,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const row = await trx
      .updateTable('message_campaigns')
      .set({
        status: failed ? 'failed' : 'sent',
        sent_at: now,
        version: sql`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', campaignId)
      .where('status', '=', 'sending')
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    await appendAuditEvent(trx, context, {
      action: 'communication.campaign.complete',
      entityType: 'message_campaign',
      entityId: campaignId,
      changes: { status: { tier: 'internal', after: row.status } },
    });
    return summary(row);
  });
}

export async function getCampaignStats(
  context: OrgContext,
  campaignId: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireCommunicationsRole(trx, context);
    const campaign = await requiredCampaign(trx, context, campaignId);
    const rows = await trx
      .selectFrom('message_deliveries')
      .select([
        'channel',
        'status',
        (eb) => eb.fn.countAll<number>().as('count'),
      ])
      .where('org_id', '=', context.orgId)
      .where('campaign_id', '=', campaignId)
      .groupBy(['channel', 'status'])
      .execute();
    const counts: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      (counts[row.channel] ??= {})[row.status] = row.count;
    }
    return { id: campaign.id, status: campaign.status, counts };
  });
}

export function campaignCategory(value: string): CommunicationCategory {
  if (
    value === 'operational' ||
    value === 'announcement' ||
    value === 'marketing' ||
    value === 'emergency'
  )
    return value;
  throw new RangeError('Campaign category is invalid');
}
