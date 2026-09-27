import { randomUUID } from 'node:crypto';

import { quietHoursDecision } from '@shared/policies/quiet-hours';
import { sql } from 'kysely';

import { withOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';
import type { EmailMessage } from '../../integrations/email/sender';
import { sendPushAndCleanup } from '../../integrations/push/sender';
import type { PushSender } from '../../integrations/push/sender';
import type { PushSubscriptionValue } from '../communications/delivery';
import {
  removePushEndpoint,
  subscriptionsForAccount,
} from '../communications/delivery';
import { systemWorkerActorId } from '../jobs/credentials-expiry';
import { preferencesCenterPath } from '../notifications/links';
import { listPreferences } from '../notifications/service';
import { getPlatformAdminDatabase } from '../platform/admin';

const chatBatchWindowMs = 10 * 60 * 1000;
const claimLeaseMs = 5 * 60 * 1000;
const maxAttempts = 5;

export type ChatBatchSenders = {
  email: EmailSender;
  push: PushSender;
  appUrl: string;
};

type PendingBatch = {
  id: string;
  org_id: string;
  conversation_id: string;
  recipient_account_id: string;
  first_message_id: string;
  latest_message_id: string;
  message_count: number;
  attempt_count: number;
};

export async function enqueueChatNotificationBatch(
  context: OrgContext,
  input: { accountId: string; conversationId: string; messageId: string },
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
): Promise<void> {
  const id = randomUUID();
  const availableAt = new Date(now.getTime() + chatBatchWindowMs);
  await runWithOrg(context, async (trx) => {
    await sql`
      INSERT INTO chat_notification_batches (
        id, org_id, conversation_id, recipient_account_id, first_message_id,
        latest_message_id, message_count, window_started_at, available_at
      )
      VALUES (
        ${id}, ${context.orgId}, ${input.conversationId}, ${input.accountId},
        ${input.messageId}, ${input.messageId}, 1, ${now}, ${availableAt}
      )
      ON CONFLICT (org_id, conversation_id, recipient_account_id)
        WHERE status = 'pending'
      DO UPDATE SET
        latest_message_id = EXCLUDED.latest_message_id,
        message_count = chat_notification_batches.message_count + 1
    `.execute(trx);
  });
}

async function claimDueBatches(
  orgId: string,
  now: Date,
  runWithOrg: typeof withOrg,
): Promise<PendingBatch[]> {
  const context = { orgId, actor: { accountId: systemWorkerActorId } };
  return runWithOrg(context, async (trx) => {
    const rows = await sql<PendingBatch>`
      UPDATE chat_notification_batches AS batch
      SET status = 'sending', claimed_at = ${now},
          attempt_count = attempt_count + 1
      WHERE batch.id IN (
        SELECT id FROM chat_notification_batches
        WHERE org_id = ${orgId}
          AND available_at <= ${now}
          AND attempt_count < ${maxAttempts}
          AND (
            status = 'pending'
            OR (status = 'sending' AND claimed_at < ${new Date(now.getTime() - claimLeaseMs)})
          )
        ORDER BY available_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 100
      )
      RETURNING id, org_id, conversation_id, recipient_account_id,
        first_message_id, latest_message_id, message_count, attempt_count
    `.execute(trx);
    return rows.rows;
  });
}

async function currentUnreadDetails(
  batch: PendingBatch,
  now: Date,
  runWithOrg: typeof withOrg,
) {
  const context = {
    orgId: batch.org_id,
    actor: { accountId: systemWorkerActorId },
  };
  return runWithOrg(context, async (trx) => {
    const result = await sql<{
      unread: boolean;
      muted: boolean;
      email: string | null;
      email_verified: boolean;
      locale: string;
      timezone: string;
      organization_name: string;
      conversation_title: string | null;
      display_name: string | null;
      email_suppressed: boolean;
    }>`
      SELECT
        (member.last_read_at IS NULL OR member.last_read_at < message.created_at) AS unread,
        member.muted,
        account.email,
        account.email_verified_at IS NOT NULL AS email_verified,
        CASE WHEN account.locale = 'es' THEN 'es' ELSE 'en' END AS locale,
        COALESCE(account.timezone, organization.timezone, 'UTC') AS timezone,
        COALESCE(identity.display_name, organization.name) AS organization_name,
        conversation.title AS conversation_title,
        EXISTS (
          SELECT 1 FROM suppressions AS suppression
          WHERE suppression.channel = 'email'
            AND suppression.address = lower(account.email)
            AND (suppression.org_id = ${batch.org_id} OR suppression.org_id IS NULL)
        ) AS email_suppressed
      FROM conversation_members AS member
      JOIN chat_messages AS message
        ON message.org_id = member.org_id
       AND message.conversation_id = member.conversation_id
       AND message.id = ${batch.latest_message_id}
      JOIN accounts AS account ON account.id = member.account_id
      JOIN organizations AS organization ON organization.id = member.org_id
      JOIN conversations AS conversation
        ON conversation.org_id = member.org_id AND conversation.id = member.conversation_id
      LEFT JOIN communication_sender_identities AS identity
        ON identity.org_id = member.org_id
      WHERE member.org_id = ${batch.org_id}
        AND member.conversation_id = ${batch.conversation_id}
        AND member.account_id = ${batch.recipient_account_id}
        AND member.revoked_at IS NULL
        AND conversation.archived_at IS NULL
      LIMIT 1
    `.execute(trx);
    const recipient = result.rows[0];
    if (!recipient) return null;
    return {
      ...recipient,
      organizationName: recipient.organization_name,
      chatTitle: recipient.locale === 'es' ? 'Nuevos mensajes' : 'New messages',
      chatBody:
        recipient.locale === 'es'
          ? `Tienes ${String(batch.message_count)} mensajes sin leer en Athlentry.`
          : `You have ${String(batch.message_count)} unread messages in Athlentry.`,
      preferencesContext: {
        orgId: batch.org_id,
        actor: { accountId: batch.recipient_account_id },
      },
      now,
    };
  });
}

async function activeSubscriptions(
  context: OrgContext,
  accountId: string,
  runWithOrg: typeof withOrg,
): Promise<PushSubscriptionValue[]> {
  const rows = await subscriptionsForAccount(context, accountId, runWithOrg);
  return rows.map((row) => row.subscription);
}

async function updateBatch(
  batch: PendingBatch,
  runWithOrg: typeof withOrg,
  input:
    | { status: 'sent' | 'skipped'; pushSent?: boolean; emailSent?: boolean }
    | { status: 'pending'; availableAt: Date; error?: string }
    | { status: 'failed'; error: string },
  now: Date,
): Promise<void> {
  const context = {
    orgId: batch.org_id,
    actor: { accountId: systemWorkerActorId },
  };
  await runWithOrg(context, async (trx) => {
    if (input.status === 'pending') {
      await trx
        .updateTable('chat_notification_batches')
        .set({
          status: 'pending',
          claimed_at: null,
          available_at: input.availableAt,
          last_error: input.error ?? null,
        })
        .where('org_id', '=', batch.org_id)
        .where('id', '=', batch.id)
        .where('status', '=', 'sending')
        .execute();
      return;
    }
    await trx
      .updateTable('chat_notification_batches')
      .set({
        status: input.status,
        claimed_at: null,
        push_sent_at: input.status === 'sent' && input.pushSent ? now : null,
        email_sent_at: input.status === 'sent' && input.emailSent ? now : null,
        last_error: input.status === 'failed' ? input.error : null,
      })
      .where('org_id', '=', batch.org_id)
      .where('id', '=', batch.id)
      .where('status', '=', 'sending')
      .execute();
  });
}

async function processBatch(
  batch: PendingBatch,
  senders: ChatBatchSenders,
  now: Date,
  runWithOrg: typeof withOrg,
): Promise<void> {
  try {
    const details = await currentUnreadDetails(batch, now, runWithOrg);
    if (!details || !details.unread || details.muted) {
      await updateBatch(batch, runWithOrg, { status: 'skipped' }, now);
      return;
    }
    const preferences = await listPreferences(
      details.preferencesContext,
      runWithOrg,
    );
    const enabled = new Map(
      preferences.items
        .filter((item) => item.category === 'operational')
        .map((item) => [item.channel, item.enabled]),
    );
    const pushAllowed = enabled.get('push') === true;
    const emailAllowed = enabled.get('email') === true;
    const context = {
      orgId: batch.org_id,
      actor: { accountId: systemWorkerActorId },
    };
    let pushSent = false;
    let pushFailed = false;
    let pushDeferredUntil: Date | null = null;
    if (pushAllowed) {
      const quiet = quietHoursDecision(
        now.toISOString(),
        details.timezone,
        'push',
        false,
      );
      if (!quiet.sendNow && quiet.nextSendAt) {
        pushDeferredUntil = new Date(quiet.nextSendAt);
      } else {
        const subscriptions = await activeSubscriptions(
          context,
          batch.recipient_account_id,
          runWithOrg,
        );
        for (const subscription of subscriptions) {
          try {
            const outcome = await sendPushAndCleanup(
              senders.push,
              subscription,
              {
                title: details.chatTitle,
                body: details.chatBody,
                url: `/me/orgs/${batch.org_id}/messages?conversation=${batch.conversation_id}`,
                tag: `chat-${batch.conversation_id}`,
              },
              {
                removeInvalidEndpoint: (endpoint) =>
                  removePushEndpoint(context, endpoint, runWithOrg),
              },
            );
            if (outcome.status === 'sent') pushSent = true;
          } catch {
            pushFailed = true;
            // Fall back to the configured email channel below.
          }
        }
      }
    }
    if (pushSent) {
      await updateBatch(
        batch,
        runWithOrg,
        { status: 'sent', pushSent: true },
        now,
      );
      return;
    }
    if (
      emailAllowed &&
      details.email &&
      details.email_verified &&
      !details.email_suppressed
    ) {
      const preferencesUrl = `${senders.appUrl.replace(/\/$/, '')}${preferencesCenterPath(batch.org_id)}`;
      const subject =
        details.locale === 'es'
          ? `${details.organizationName}: tienes mensajes sin leer`
          : `${details.organizationName}: unread conversation messages`;
      const message: EmailMessage = {
        to: details.email,
        subject,
        text: `${details.chatBody}\n\n${preferencesUrl}`,
        html: `<p>${details.chatBody}</p><p><a href="${preferencesUrl}">${details.locale === 'es' ? 'Administrar preferencias de notificación' : 'Manage notification preferences'}</a></p>`,
        kind: 'transactional',
        idempotencyKey: `athlentry:chat:${batch.org_id}:${batch.conversation_id}:${batch.first_message_id}:${batch.recipient_account_id}`,
      };
      await senders.email.send(message);
      await updateBatch(
        batch,
        runWithOrg,
        { status: 'sent', emailSent: true },
        now,
      );
      return;
    }
    if (pushDeferredUntil) {
      await updateBatch(
        batch,
        runWithOrg,
        { status: 'pending', availableAt: pushDeferredUntil },
        now,
      );
      return;
    }
    if (pushFailed && !emailAllowed)
      throw new Error('Push notification delivery failed');
    await updateBatch(batch, runWithOrg, { status: 'skipped' }, now);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 300)
        : 'Chat delivery failed';
    if (batch.attempt_count < maxAttempts) {
      await updateBatch(
        batch,
        runWithOrg,
        {
          status: 'pending',
          availableAt: new Date(
            now.getTime() + 60_000 * 2 ** (batch.attempt_count - 1),
          ),
          error: message,
        },
        now,
      );
      return;
    }
    await updateBatch(
      batch,
      runWithOrg,
      { status: 'failed', error: message },
      now,
    );
  }
}

export async function processDueChatNotificationBatches(
  orgId: string,
  senders: ChatBatchSenders,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
): Promise<number> {
  const batches = await claimDueBatches(orgId, now, runWithOrg);
  for (const batch of batches)
    await processBatch(batch, senders, now, runWithOrg);
  return batches.length;
}

export async function runChatNotificationBatchJob(): Promise<number> {
  const organizations = await getPlatformAdminDatabase()
    .selectFrom('organizations')
    .select('id')
    .where('status', '=', 'active')
    .orderBy('id')
    .execute();
  const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:5173';
  const { createCommunicationAdapters } =
    await import('../communications/adapters');
  const { createMailpitEmailSender } =
    await import('../../integrations/email/sender');
  const senders = createCommunicationAdapters({
    appUrl,
    ...(process.env.DELIVERY_MODE === 'live'
      ? {}
      : { email: createMailpitEmailSender() }),
  });
  let processed = 0;
  for (const organization of organizations) {
    processed += await processDueChatNotificationBatches(
      organization.id,
      { email: senders.email, push: senders.push, appUrl },
      new Date(),
    );
  }
  return processed;
}
