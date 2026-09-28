import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';

import { evaluateOperationalAlerts } from './alerts';
import type { OperationalMetrics, OperationalSignal } from './alerts';
import { writeStructuredLog } from './logging';
import { captureOperationalAlert, captureRedactedException } from './sentry';

const systemActorId = '00000000-0000-0000-0000-000000000000';
const pollIntervalMs = 30_000;
const tenantQueryConcurrency = 8;

type TenantMetrics = {
  lastSuccessfulChargeAt: Date | null;
  paymentAttempts15m: number;
  paymentFailures15m: number;
  emails30m: number;
  emailBounces30m: number;
};

type GlobalMetrics = {
  workerHeartbeatAt: Date | null;
  pendingJobs: number;
  failedJobs: number;
  lastStripeWebhookAt: Date | null;
};

export function nextBacklogThresholdStart(
  pendingJobs: number,
  previousStart: Date | null,
  now: Date,
): Date | null {
  if (pendingJobs <= 1_000) return null;
  return previousStart ?? now;
}

export function createOperationalAlertReporter(
  onAlert: (signal: OperationalSignal) => void,
): (signals: readonly OperationalSignal[]) => void {
  let active = new Set<OperationalSignal>();
  return (signals) => {
    const next = new Set(signals);
    for (const signal of next) {
      if (!active.has(signal)) onAlert(signal);
    }
    active = next;
  };
}

async function collectTenantMetrics(
  database: Kysely<DB>,
  orgId: string,
): Promise<TenantMetrics> {
  const withOrg = createWithOrg(database);
  const result = await withOrg(
    { orgId, actor: { accountId: systemActorId } },
    (trx) =>
      sql<TenantMetrics>`
        SELECT
          payment_metrics."lastSuccessfulChargeAt",
          payment_metrics."paymentAttempts15m",
          payment_metrics."paymentFailures15m",
          delivery_metrics."emails30m",
          delivery_metrics."emailBounces30m"
        FROM (
          SELECT
            max(succeeded_at) AS "lastSuccessfulChargeAt",
            count(*) FILTER (
              WHERE created_at >= now() - interval '15 minutes'
            )::integer AS "paymentAttempts15m",
            count(*) FILTER (
              WHERE created_at >= now() - interval '15 minutes'
                AND status = 'failed'
            )::integer AS "paymentFailures15m"
          FROM payments
        ) AS payment_metrics
        CROSS JOIN (
          SELECT
            count(*)::integer AS "emails30m",
            count(*) FILTER (WHERE status = 'bounced')::integer
              AS "emailBounces30m"
          FROM message_deliveries
          WHERE channel = 'email'
            AND sent_at >= now() - interval '30 minutes'
        ) AS delivery_metrics
      `.execute(trx),
  );
  return (
    result.rows[0] ?? {
      lastSuccessfulChargeAt: null,
      paymentAttempts15m: 0,
      paymentFailures15m: 0,
      emails30m: 0,
      emailBounces30m: 0,
    }
  );
}

export async function collectOperationalMetrics(
  database: Kysely<DB>,
  backlogSince: Date | null = null,
): Promise<OperationalMetrics> {
  const now = new Date();
  const [globalResult, organizations] = await Promise.all([
    sql<GlobalMetrics>`
      SELECT
        (SELECT max(heartbeat_at) FROM worker_heartbeats
          WHERE stopped_at IS NULL) AS "workerHeartbeatAt",
        (SELECT count(*)::integer FROM pgboss.job
          WHERE state IN ('created', 'retry')) AS "pendingJobs",
        (SELECT count(*)::integer FROM pgboss.job
          WHERE state = 'failed') AS "failedJobs",
        (SELECT max(received_at) FROM stripe_events) AS "lastStripeWebhookAt"
    `.execute(database),
    // The organization table is the global tenant directory; all tenant table
    // reads below are scoped through withOrg.
    database.selectFrom('organizations').select('id').execute(),
  ]);
  const global = globalResult.rows[0];
  if (!global) throw new Error('Global operational metrics were unavailable');

  const orgIds = organizations.map(({ id }) => id);
  const tenantResults = new Array<TenantMetrics>(orgIds.length);
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(tenantQueryConcurrency, orgIds.length) },
      async () => {
        while (cursor < orgIds.length) {
          const index = cursor;
          cursor += 1;
          const orgId = orgIds[index];
          if (orgId)
            tenantResults[index] = await collectTenantMetrics(database, orgId);
        }
      },
    ),
  );
  const total = tenantResults.reduce<TenantMetrics>(
    (sum, tenant) => ({
      lastSuccessfulChargeAt:
        tenant.lastSuccessfulChargeAt &&
        (!sum.lastSuccessfulChargeAt ||
          tenant.lastSuccessfulChargeAt > sum.lastSuccessfulChargeAt)
          ? tenant.lastSuccessfulChargeAt
          : sum.lastSuccessfulChargeAt,
      paymentAttempts15m: sum.paymentAttempts15m + tenant.paymentAttempts15m,
      paymentFailures15m: sum.paymentFailures15m + tenant.paymentFailures15m,
      emails30m: sum.emails30m + tenant.emails30m,
      emailBounces30m: sum.emailBounces30m + tenant.emailBounces30m,
    }),
    {
      lastSuccessfulChargeAt: null,
      paymentAttempts15m: 0,
      paymentFailures15m: 0,
      emails30m: 0,
      emailBounces30m: 0,
    },
  );

  return {
    now,
    workerHeartbeatAt: global.workerHeartbeatAt,
    pendingJobs: global.pendingJobs,
    backlogOverThresholdSince: nextBacklogThresholdStart(
      global.pendingJobs,
      backlogSince,
      now,
    ),
    failedJobs: global.failedJobs,
    lastSuccessfulChargeAt: total.lastSuccessfulChargeAt,
    lastStripeWebhookAt: global.lastStripeWebhookAt,
    paymentAttempts15m: total.paymentAttempts15m,
    paymentFailures15m: total.paymentFailures15m,
    emails30m: total.emails30m,
    emailBounces30m: total.emailBounces30m,
  };
}

export function startOperationalAlerts(connectionString: string): {
  stop: () => Promise<void>;
} {
  const database = createDatabase(connectionString);
  let backlogSince: Date | null = null;
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const report = createOperationalAlertReporter((signal) => {
    captureOperationalAlert(signal);
    writeStructuredLog('warn', 'ops.alert.raised', {
      operation: signal,
      result: 'failed',
    });
  });

  const poll = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = (async () => {
      try {
        const metrics = await collectOperationalMetrics(database, backlogSince);
        backlogSince = metrics.backlogOverThresholdSince;
        report(evaluateOperationalAlerts(metrics));
      } catch (error) {
        captureRedactedException(error);
        writeStructuredLog('error', 'ops.alert.poll.failed', {
          result: 'failed',
        });
      }
    })();
    await inFlight;
    inFlight = undefined;
  };

  const timer = setInterval(() => void poll(), pollIntervalMs);
  void poll();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      await database.destroy();
    },
  };
}
