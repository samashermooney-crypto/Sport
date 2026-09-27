import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import type { EmailSender } from '../../integrations/email/sender.js';
import { appendAuditEvent } from '../audit/service.js';
import { createNotification } from '../notifications/service.js';

export type FinanceNoticeKind = 'invoice_issued' | 'payment_received';
interface NoticeRow {
  id: string;
  account_id: string;
  kind: FinanceNoticeKind;
  source_id: string;
  message_key: string;
  lease_token: string;
}

/** Commit the notification and durable email intent in the money transaction. */
export async function enqueueFinanceNotice(
  trx: OrgTransaction,
  context: OrgContext,
  input: { kind: FinanceNoticeKind; sourceId: string; accountId: string },
): Promise<boolean> {
  const owned =
    input.kind === 'invoice_issued'
      ? await trx
          .selectFrom('invoices')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('id', '=', input.sourceId)
          .where('account_id', '=', input.accountId)
          .executeTakeFirst()
      : await trx
          .selectFrom('payments')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('id', '=', input.sourceId)
          .where('account_id', '=', input.accountId)
          .where('status', '=', 'succeeded')
          .executeTakeFirst();
  if (!owned) throw new Error('Finance notice recipient does not own source');
  const id = newId();
  const key = newId();
  const inserted = await sql<{ id: string }>`
    INSERT INTO finance_notice_outbox
      (id, org_id, account_id, kind, source_id, message_key)
    VALUES (${id}::uuid, ${context.orgId}::uuid,
      ${input.accountId}::uuid, ${input.kind},
      ${input.sourceId}::uuid, ${key}::uuid)
    ON CONFLICT (org_id, kind, source_id) DO NOTHING RETURNING id
  `.execute(trx);
  if (!inserted.rows.length) return false;
  const resourceType = input.kind === 'invoice_issued' ? 'invoice' : 'payment';
  await createNotification(trx, context, {
    accountId: input.accountId,
    type:
      input.kind === 'invoice_issued' ? 'invoice.issued' : 'payment.succeeded',
    payload: { resourceType, resourceId: input.sourceId },
  });
  await appendAuditEvent(trx, context, {
    action: 'finance.notice_queued',
    entityType: resourceType,
    entityId: input.sourceId,
    changes: { kind: { tier: 'internal', after: input.kind } },
  });
  return true;
}

/** One-org worker contract; a system actor is supplied by the worker registry. */
export class PostgresFinanceNoticeDelivery {
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
          SELECT id FROM finance_notice_outbox
          WHERE org_id = ${this.context.orgId}::uuid
            AND (status IN ('queued', 'failed') OR
              (status = 'sending' AND lease_until < now()))
          ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE finance_notice_outbox o SET status = 'sending',
          attempts = attempts + 1, lease_token = ${newId()}::uuid,
          lease_until = now() + interval '5 minutes', last_error = NULL
        FROM next WHERE o.org_id = ${this.context.orgId}::uuid
          AND o.id = next.id
        RETURNING o.id, o.account_id, o.kind, o.source_id,
          o.message_key, o.lease_token
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
      await this.finish(notice, 'suppressed', null);
      return 'suppressed';
    }
    const title =
      notice.kind === 'invoice_issued'
        ? 'Your invoice is ready'
        : 'Your payment receipt is ready';
    const path =
      notice.kind === 'invoice_issued'
        ? `/orgs/${this.context.orgId}/money/invoices`
        : `/orgs/${this.context.orgId}/money/receipts`;
    const url = new URL(path, this.appUrl).toString();
    try {
      const sent = await this.sender.send({
        to: recipient.email,
        subject: title,
        text: `${title}. Sign in to Athlentry to view it: ${url}`,
        kind: 'transactional',
        idempotencyKey: notice.message_key,
      });
      await this.finish(notice, 'sent', sent.providerId);
      return 'sent';
    } catch (error) {
      await this.finish(notice, 'failed', null);
      throw error;
    }
  }

  private async finish(
    notice: NoticeRow,
    status: 'sent' | 'failed' | 'suppressed',
    providerId: string | null,
  ): Promise<void> {
    await this.withOrg(this.context, async (trx) => {
      const updated = await sql<{ id: string }>`
        UPDATE finance_notice_outbox SET status = ${status},
          provider_message_id = ${providerId},
          sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE sent_at END,
          lease_token = NULL, lease_until = NULL,
          last_error = CASE WHEN ${status} = 'failed'
            THEN 'Delivery failed; retry uses the same provider key' ELSE NULL END
        WHERE org_id = ${this.context.orgId}::uuid
          AND id = ${notice.id}::uuid
          AND status = 'sending' AND lease_token = ${notice.lease_token}::uuid
        RETURNING id
      `.execute(trx);
      if (!updated.rows.length)
        throw new Error('Finance notice lease was lost');
      await appendAuditEvent(trx, this.context, {
        action: `finance.notice_${status}`,
        entityType: 'finance_notice',
        entityId: notice.id,
        changes: {},
      });
    });
  }
}
