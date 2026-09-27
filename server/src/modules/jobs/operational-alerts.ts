import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import {
  evaluateOperationalAlerts,
  type OperationalMetrics,
  type OperationalSignal,
} from '../../lib/observability/alerts';
import { writeStructuredLog } from '../../lib/observability/logging';
import { captureOperationalAlert } from '../../lib/observability/sentry';
import { getPlatformAdminDatabase } from '../platform/admin';

import { systemWorkerActorId } from './credentials-expiry';

let activeSignals = new Set<OperationalSignal>();

type QueueMetrics = {
  pending: number | string;
  failed: number | string;
  oldest_pending_at: Date | null;
};

type TenantMetrics = {
  payment_attempts: number | string;
  payment_failures: number | string;
  last_successful_charge_at: Date | null;
  emails: number | string;
  email_bounces: number | string;
};

function numeric(value: number | string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function readOperationalMetrics(
  database: Kysely<DB>,
  now = new Date(),
  administrativeDatabase: Kysely<DB> = getPlatformAdminDatabase(),
): Promise<OperationalMetrics> {
  const [queueResult, heartbeatResult, webhookResult, organizations] =
    await Promise.all([
      sql<QueueMetrics>`
        SELECT
          count(*) FILTER (WHERE state IN ('created', 'retry'))::integer AS pending,
          count(*) FILTER (WHERE state = 'failed')::integer AS failed,
          min(created_on) FILTER (WHERE state IN ('created', 'retry')) AS oldest_pending_at
        FROM pgboss.job
      `.execute(database),
      sql<{ heartbeat_at: Date }>`
        SELECT heartbeat_at FROM worker_heartbeats
        WHERE stopped_at IS NULL
        ORDER BY heartbeat_at DESC LIMIT 1
      `.execute(database),
      sql<{ received_at: Date }>`
        SELECT received_at FROM stripe_events
        ORDER BY received_at DESC LIMIT 1
      `.execute(database),
      administrativeDatabase
        .selectFrom('organizations')
        .select('id')
        .where('status', '=', 'active')
        .orderBy('id')
        .execute(),
    ]);

  const queue = queueResult.rows[0];
  const pendingJobs = numeric(queue?.pending ?? 0);
  const oldestPendingAt = queue?.oldest_pending_at ?? null;
  const backlogOverThresholdSince =
    pendingJobs > 1_000 ? oldestPendingAt : null;
  let paymentAttempts15m = 0;
  let paymentFailures15m = 0;
  let lastSuccessfulChargeAt: Date | null = null;
  let emails30m = 0;
  let emailBounces30m = 0;
  const withOrg = createWithOrg(database);
  const contexts = organizations.map(
    (organization) => async () =>
      withOrg(
        {
          orgId: organization.id,
          actor: { accountId: systemWorkerActorId },
        },
        async (trx) =>
          sql<TenantMetrics>`
          SELECT
            (SELECT count(*)::integer FROM payments
              WHERE org_id = ${organization.id}::uuid
                AND created_at >= ${new Date(now.getTime() - 15 * 60_000)}
            ) AS payment_attempts,
            (SELECT count(*)::integer FROM payments
              WHERE org_id = ${organization.id}::uuid
                AND created_at >= ${new Date(now.getTime() - 15 * 60_000)}
                AND status = 'failed'
            ) AS payment_failures,
            (SELECT max(succeeded_at) FROM payments
              WHERE org_id = ${organization.id}::uuid
            ) AS last_successful_charge_at,
            (SELECT count(*)::integer FROM message_deliveries
              WHERE org_id = ${organization.id}::uuid
                AND channel = 'email'
                AND created_at >= ${new Date(now.getTime() - 30 * 60_000)}
                AND status IN ('sent', 'delivered', 'bounced', 'complained', 'failed', 'opened', 'clicked')
            ) AS emails,
            (SELECT count(*)::integer FROM message_deliveries
              WHERE org_id = ${organization.id}::uuid
                AND channel = 'email'
                AND created_at >= ${new Date(now.getTime() - 30 * 60_000)}
                AND status = 'bounced'
            ) AS email_bounces
        `.execute(trx),
      ),
  );

  for (let index = 0; index < contexts.length; index += 8) {
    const results = await Promise.all(
      contexts.slice(index, index + 8).map((load) => load()),
    );
    for (const result of results) {
      const row = result.rows[0];
      if (!row) continue;
      paymentAttempts15m += numeric(row.payment_attempts);
      paymentFailures15m += numeric(row.payment_failures);
      emails30m += numeric(row.emails);
      emailBounces30m += numeric(row.email_bounces);
      if (
        row.last_successful_charge_at &&
        (!lastSuccessfulChargeAt ||
          row.last_successful_charge_at > lastSuccessfulChargeAt)
      ) {
        lastSuccessfulChargeAt = row.last_successful_charge_at;
      }
    }
  }

  return {
    now,
    workerHeartbeatAt: heartbeatResult.rows[0]?.heartbeat_at ?? null,
    pendingJobs,
    backlogOverThresholdSince,
    failedJobs: numeric(queue?.failed ?? 0),
    lastSuccessfulChargeAt,
    lastStripeWebhookAt: webhookResult.rows[0]?.received_at ?? null,
    paymentAttempts15m,
    paymentFailures15m,
    emails30m,
    emailBounces30m,
  };
}

export async function runOperationalAlertCheck(
  database?: Kysely<DB>,
): Promise<{ active: OperationalSignal[]; newlyActive: OperationalSignal[] }> {
  const metrics = await readOperationalMetrics(
    database ?? (await import('../../db/kysely')).getDatabase(),
  );
  const active = evaluateOperationalAlerts(metrics);
  const newlyActive = active.filter((signal) => !activeSignals.has(signal));
  for (const signal of newlyActive) {
    writeStructuredLog('warn', 'ops.alert', {
      operation: signal.replaceAll('_', '-'),
      result: 'failed',
    });
    captureOperationalAlert(signal);
  }
  activeSignals = new Set(active);
  return { active, newlyActive };
}
