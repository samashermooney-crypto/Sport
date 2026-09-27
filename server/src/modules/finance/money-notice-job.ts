import type { Kysely } from 'kysely';

import { getDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import {
  createMailpitEmailSender,
  createResendEmailSender,
  type EmailSender,
} from '../../integrations/email/sender.js';
import { systemWorkerActorId } from '../jobs/credentials-expiry.js';

import { PostgresFinanceNoticeDelivery } from './money-notices.js';

export interface FinanceNoticeJobDependencies {
  database: Kysely<DB>;
  sender: EmailSender;
  appUrl: string;
  organizationIds?: readonly string[];
}

/** Scan global org IDs; each outbox claim and send remains org scoped. */
export async function deliverFinanceNotices(
  dependencies: FinanceNoticeJobDependencies,
): Promise<{ sent: number; suppressed: number }> {
  const organizationIds =
    dependencies.organizationIds ??
    (
      await dependencies.database
        .selectFrom('organizations')
        .select('id')
        .where('status', '=', 'active')
        .orderBy('id')
        .execute()
    ).map(({ id }) => id);
  let sent = 0;
  let suppressed = 0;
  for (const orgId of organizationIds) {
    const delivery = new PostgresFinanceNoticeDelivery(
      dependencies.database,
      { orgId, actor: { accountId: systemWorkerActorId } },
      dependencies.sender,
      dependencies.appUrl,
    );
    for (let index = 0; index < 100; index += 1) {
      const outcome = await delivery.deliverOne();
      if (outcome === 'empty') break;
      if (outcome === 'sent') sent += 1;
      else suppressed += 1;
    }
  }
  return { sent, suppressed };
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required for finance notices`);
  return value;
}

export function runFinanceNoticeJob(): Promise<{
  sent: number;
  suppressed: number;
}> {
  const live = process.env.DELIVERY_MODE === 'live';
  if (live && process.env.NODE_ENV !== 'production')
    throw new Error('Live finance notices require production mode');
  const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:5173';
  if (live && new URL(appUrl).protocol !== 'https:')
    throw new Error('Live finance notice links require HTTPS');
  const sender = live
    ? createResendEmailSender({
        apiKey: required('RESEND_API_KEY'),
        from: required('EMAIL_FROM'),
      })
    : createMailpitEmailSender();
  return deliverFinanceNotices({
    database: getDatabase(),
    sender,
    appUrl,
  });
}
