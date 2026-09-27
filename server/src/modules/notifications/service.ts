import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { decodeCursor, pageFromRows } from '../../lib/pagination';
import { VersionConflictError } from '../../lib/version-check';
import { appendAuditEvent } from '../audit/service';

import { isNotificationType, notificationCatalog } from './catalog';
import type { NotificationCategory, NotificationType } from './catalog';
import {
  inboxPageSchema,
  notificationPayloadSchema,
  notificationSchema,
  preferenceSchema,
  preferencesSchema,
} from './schema';

export class NotificationAccessError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
}

export class NotificationSuspendedError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
}

async function requireMembership(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<void> {
  const member = await trx
    .selectFrom('org_memberships')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!member) throw new NotificationAccessError('Inbox not found');
  const organization = await trx
    .selectFrom('organizations')
    .select('status')
    .where('id', '=', context.orgId)
    .executeTakeFirstOrThrow();
  if (organization.status === 'suspended')
    throw new NotificationSuspendedError('Organization is suspended');
}

export async function createNotification(
  trx: OrgTransaction,
  context: OrgContext,
  input: {
    accountId: string;
    type: NotificationType;
    payload: unknown;
  },
): Promise<string> {
  if (!isNotificationType(input.type))
    throw new RangeError('Unknown notification type');
  const payload = notificationPayloadSchema.parse(input.payload);
  const id = randomUUID();
  await trx
    .insertInto('notifications')
    .values({
      id,
      org_id: context.orgId,
      account_id: input.accountId,
      type: input.type,
      payload: payload as Json,
      delivered_channels: ['in_app'],
    })
    .execute();
  await appendAuditEvent(trx, context, {
    action: 'notification.create',
    entityType: 'notification',
    entityId: id,
    changes: { type: { tier: 'internal', after: input.type } },
  });
  return id;
}

export async function listInbox(
  context: OrgContext,
  input: { limit: number; cursor?: string; unreadOnly?: boolean },
  runWithOrg: typeof withOrg = withOrg,
): Promise<ReturnType<typeof inboxPageSchema.parse>> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 200
  )
    throw new RangeError('Inbox page limit must be 1–200');
  return runWithOrg(context, async (trx) => {
    await requireMembership(trx, context);
    let query = trx
      .selectFrom('notifications')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId);
    if (input.unreadOnly) query = query.where('read_at', 'is', null);
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor, 'created_at');
      const date = new Date(String(cursor.value));
      if (Number.isNaN(date.valueOf()))
        throw new RangeError('Invalid inbox cursor date');
      query = query.where((expression) =>
        expression.or([
          expression.eb('created_at', '<', date),
          expression.and([
            expression.eb('created_at', '=', date),
            expression.eb('id', '<', cursor.id),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit + 1)
      .execute();
    const page = pageFromRows(rows, input.limit, (row) => ({
      sort: 'created_at',
      value: row.created_at.toISOString(),
      id: row.id,
    }));
    return inboxPageSchema.parse({
      items: page.items.map((row) => {
        if (!isNotificationType(row.type))
          throw new RangeError('Unknown stored notification type');
        return notificationSchema.parse({
          id: row.id,
          orgId: row.org_id,
          type: row.type,
          title: notificationCatalog[row.type].title,
          payload: row.payload,
          readAt: row.read_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
        });
      }),
      nextCursor: page.nextCursor,
    });
  });
}

export async function markNotificationRead(
  context: OrgContext,
  notificationId: string,
  now: Date,
  runWithOrg: typeof withOrg = withOrg,
): Promise<Date> {
  return runWithOrg(context, async (trx) => {
    await requireMembership(trx, context);
    const row = await trx
      .updateTable('notifications')
      .set({ read_at: now })
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('id', '=', notificationId)
      .where('read_at', 'is', null)
      .returning('read_at')
      .executeTakeFirst();
    if (row?.read_at) {
      await appendAuditEvent(trx, context, {
        action: 'notification.read',
        entityType: 'notification',
        entityId: notificationId,
      });
      return row.read_at;
    }
    const current = await trx
      .selectFrom('notifications')
      .select('read_at')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('id', '=', notificationId)
      .executeTakeFirst();
    if (!current) throw new NotificationAccessError('Notification not found');
    return current.read_at ?? now;
  });
}

const categories = [
  'operational',
  'announcement',
  'marketing',
  'emergency',
] as const;
const channels = ['in_app', 'email'] as const;
export type PreferenceChannel = (typeof channels)[number];

export async function listPreferences(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
): Promise<ReturnType<typeof preferencesSchema.parse>> {
  return runWithOrg(context, async (trx) => {
    await requireMembership(trx, context);
    const rows = await trx
      .selectFrom('communication_preferences')
      .select(['category', 'channel', 'enabled', 'version'])
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .execute();
    const byKey = new Map(
      rows.map((row) => [`${row.category}:${row.channel}`, row]),
    );
    return preferencesSchema.parse({
      items: categories.flatMap((category) =>
        channels.map((channel) => {
          const current = byKey.get(`${category}:${channel}`);
          return preferenceSchema.parse({
            category,
            channel,
            enabled: current?.enabled ?? category !== 'marketing',
            version: current?.version ?? 0,
          });
        }),
      ),
    });
  });
}

export async function updatePreference(
  context: OrgContext,
  input: {
    category: NotificationCategory;
    channel: PreferenceChannel;
    enabled: boolean;
    expectedVersion: number;
  },
  runWithOrg: typeof withOrg = withOrg,
): Promise<ReturnType<typeof preferenceSchema.parse>> {
  return runWithOrg(context, async (trx) => {
    await requireMembership(trx, context);
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${context.orgId}:${context.actor.accountId}:${input.category}`}, 0))`.execute(
      trx,
    );
    const existing = await trx
      .selectFrom('communication_preferences')
      .select(['id', 'enabled', 'version'])
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('category', '=', input.category)
      .where('channel', '=', input.channel)
      .executeTakeFirst();
    const current = {
      category: input.category,
      channel: input.channel,
      enabled: existing?.enabled ?? input.category !== 'marketing',
      version: existing?.version ?? 0,
    };
    if (current.version !== input.expectedVersion)
      throw new VersionConflictError(current);
    if (
      !input.enabled &&
      (input.category === 'operational' || input.category === 'emergency')
    ) {
      const otherChannel = input.channel === 'in_app' ? 'email' : 'in_app';
      const other = await trx
        .selectFrom('communication_preferences')
        .select('enabled')
        .where('org_id', '=', context.orgId)
        .where('account_id', '=', context.actor.accountId)
        .where('category', '=', input.category)
        .where('channel', '=', otherChannel)
        .executeTakeFirst();
      if (other?.enabled === false)
        throw new RangeError('At least one delivery channel must stay enabled');
    }
    if (existing) {
      const updated = await trx
        .updateTable('communication_preferences')
        .set({ enabled: input.enabled, version: existing.version + 1 })
        .where('id', '=', existing.id)
        .where('version', '=', existing.version)
        .returning(['enabled', 'version'])
        .executeTakeFirst();
      if (!updated) throw new VersionConflictError(current);
      await appendAuditEvent(trx, context, {
        action: 'communication_preference.update',
        entityType: 'communication_preference',
        entityId: existing.id,
        changes: {
          enabled: {
            tier: 'internal',
            before: current.enabled,
            after: input.enabled,
          },
        },
      });
      return preferenceSchema.parse({ ...current, ...updated });
    }
    const insertedId = randomUUID();
    const inserted = await trx
      .insertInto('communication_preferences')
      .values({
        id: insertedId,
        org_id: context.orgId,
        account_id: context.actor.accountId,
        category: input.category,
        channel: input.channel,
        enabled: input.enabled,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['org_id', 'account_id', 'category', 'channel'])
          .doNothing(),
      )
      .returning(['enabled', 'version'])
      .executeTakeFirst();
    if (!inserted) throw new VersionConflictError(current);
    await appendAuditEvent(trx, context, {
      action: 'communication_preference.create',
      entityType: 'communication_preference',
      entityId: insertedId,
      changes: {
        enabled: { tier: 'internal', after: input.enabled },
      },
    });
    return preferenceSchema.parse({ ...current, ...inserted });
  });
}
