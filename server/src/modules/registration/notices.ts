import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import type { EmailSender } from '../../integrations/email/sender.js';
import { appendAuditEvent } from '../audit/service.js';
import type { NotificationType } from '../notifications/catalog.js';
import { createNotification } from '../notifications/service.js';

export const registrationNoticeKinds = [
  'registration_confirmed',
  'registration_pending_approval',
  'payment_link',
  'waitlist_joined',
  'waitlist_offer',
  'waitlist_offer_expiring',
  'approval_approved',
  'approval_declined',
  'registration_canceled',
  'registration_transferred',
  'checkout_reminder',
  'team_entry_invite',
  'team_entry_status',
] as const;
export type RegistrationNoticeKind = (typeof registrationNoticeKinds)[number];

export interface RegistrationNoticeInput {
  kind: RegistrationNoticeKind;
  sourceId: string;
  accountId: string;
  payload?: Record<string, unknown>;
}

const IN_APP_NOTICE_TYPES: Partial<
  Record<RegistrationNoticeKind, NotificationType>
> = {
  registration_confirmed: 'registration.confirmed',
  waitlist_joined: 'registration.waitlisted',
  waitlist_offer: 'registration.offered',
  waitlist_offer_expiring: 'registration.offered',
  approval_approved: 'registration.approved',
  approval_declined: 'registration.declined',
  registration_canceled: 'registration.canceled',
  registration_transferred: 'registration.transferred',
  checkout_reminder: 'checkout.abandoned',
};

/** Commit a family-facing email+in-app intent beside its source change. */
export async function enqueueRegistrationNotice(
  trx: OrgTransaction,
  context: OrgContext,
  input: RegistrationNoticeInput,
): Promise<boolean> {
  const id = newId();
  const key = newId();
  const inserted = await sql<{ id: string }>`
    INSERT INTO registration_notice_outbox
      (id, org_id, account_id, kind, source_id, message_key, payload)
    VALUES (${id}::uuid, ${context.orgId}::uuid,
      ${input.accountId}::uuid, ${input.kind}, ${input.sourceId}::uuid,
      ${key}::uuid, ${JSON.stringify(input.payload ?? {})}::jsonb)
    ON CONFLICT (org_id, kind, source_id) DO NOTHING RETURNING id
  `.execute(trx);
  if (!inserted.rows.length) return false;
  const notificationType = IN_APP_NOTICE_TYPES[input.kind];
  if (notificationType) {
    await createNotification(trx, context, {
      accountId: input.accountId,
      type: notificationType,
      payload: { href: noticePath(input.kind, context.orgId) },
    });
  }
  await appendAuditEvent(trx, context, {
    action: 'registration.notice_queued',
    entityType: 'registration_notice',
    entityId: input.sourceId,
    changes: { kind: { tier: 'internal', after: input.kind } },
  });
  return true;
}

interface NoticeRow {
  id: string;
  account_id: string;
  kind: RegistrationNoticeKind;
  source_id: string;
  message_key: string;
  lease_token: string;
  payload: Json;
}

const TITLES: Record<RegistrationNoticeKind, string> = {
  registration_confirmed: 'Registration confirmed',
  registration_pending_approval: 'Registration received — pending approval',
  payment_link: 'Your registration is ready for payment',
  waitlist_joined: 'You are on the waitlist',
  waitlist_offer: 'A spot opened up — claim it now',
  waitlist_offer_expiring: 'Your waitlist offer expires soon',
  approval_approved: 'Registration approved',
  approval_declined: 'Registration was not approved',
  registration_canceled: 'Registration canceled',
  registration_transferred: 'Registration transferred',
  checkout_reminder: 'Finish your registration — your spot is held',
  team_entry_invite: 'You are invited to join a team',
  team_entry_status: 'Team entry update',
};

function noticePath(kind: RegistrationNoticeKind, orgId: string): string {
  switch (kind) {
    case 'waitlist_offer':
    case 'waitlist_offer_expiring':
    case 'waitlist_joined':
      return `/portal/orgs/${orgId}/registrations`;
    case 'payment_link':
      return `/portal/orgs/${orgId}/register`;
    case 'registration_confirmed':
    case 'registration_pending_approval':
    case 'registration_canceled':
    case 'registration_transferred':
    case 'approval_approved':
    case 'approval_declined':
      return `/portal/orgs/${orgId}/registrations`;
    case 'checkout_reminder':
      return `/portal/orgs/${orgId}/register`;
    case 'team_entry_invite':
    case 'team_entry_status':
      return `/portal/orgs/${orgId}/registrations`;
  }
}

/** One-org worker contract; a system actor is supplied by the worker registry. */
export class PostgresRegistrationNoticeDelivery {
  private readonly withOrg: ReturnType<typeof createWithOrg>;
  constructor(
    database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly sender: EmailSender,
    private readonly appUrl: string,
  ) {
    this.withOrg = createWithOrg(database);
  }

  async deliverOne(): Promise<'sent' | 'suppressed' | 'empty'> {
    const notice = await this.withOrg(this.context, async (trx) => {
      const result = await sql<NoticeRow>`
        WITH next AS (
          SELECT id FROM registration_notice_outbox
          WHERE org_id = ${this.context.orgId}::uuid
            AND (status IN ('queued', 'failed') OR
              (status = 'sending' AND lease_until < now()))
          ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE registration_notice_outbox o SET status = 'sending',
          attempts = attempts + 1, lease_token = ${newId()}::uuid,
          lease_until = now() + interval '5 minutes', last_error = NULL
        FROM next WHERE o.org_id = ${this.context.orgId}::uuid
          AND o.id = next.id
        RETURNING o.id, o.account_id, o.kind, o.source_id,
          o.message_key, o.lease_token, o.payload
      `.execute(trx);
      return result.rows[0] ?? null;
    });
    if (!notice) return 'empty';
    const recipient = await this.withOrg(this.context, (trx) =>
      trx
        .selectFrom('accounts')
        .select(['email', 'email_verified_at', 'status'])
        .where('id', '=', notice.account_id)
        .executeTakeFirstOrThrow(),
    );
    if (!recipient.email_verified_at || recipient.status !== 'active') {
      await this.finish(notice, 'suppressed', null, null);
      return 'suppressed';
    }
    const title = TITLES[notice.kind];
    const url = new URL(
      noticePath(notice.kind, this.context.orgId),
      this.appUrl,
    ).toString();
    try {
      const sent = await this.sender.send({
        to: recipient.email,
        subject: title,
        text: `${title}. Sign in to Athlentry to view details: ${url}`,
        kind: 'transactional',
        idempotencyKey: notice.message_key,
      });
      await this.finish(notice, 'sent', sent.providerId, null);
      return 'sent';
    } catch (error) {
      await this.finish(
        notice,
        'failed',
        null,
        error instanceof Error ? error.message : 'send failed',
      );
      return 'suppressed';
    }
  }

  private async finish(
    notice: NoticeRow,
    status: 'sent' | 'failed' | 'suppressed',
    providerMessageId: string | null,
    lastError: string | null,
  ): Promise<void> {
    await this.withOrg(this.context, async (trx) => {
      await sql`
        UPDATE registration_notice_outbox
        SET status = ${status}, provider_message_id = ${providerMessageId},
          sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE NULL END,
          last_error = ${lastError}, lease_token = NULL, lease_until = NULL
        WHERE org_id = ${this.context.orgId}::uuid AND id = ${notice.id}::uuid
          AND lease_token = ${notice.lease_token}::uuid
      `.execute(trx);
    });
  }
}

export const registrationNoticeListSchema = z.strictObject({
  notices: z.array(
    z.strictObject({
      id: z.uuid(),
      kind: z.string(),
      accountId: z.uuid(),
      status: z.string(),
      attempts: z.number().int().nonnegative(),
      createdAt: z.string(),
      sentAt: z.string().nullable(),
      lastError: z.string().nullable(),
    }),
  ),
});
