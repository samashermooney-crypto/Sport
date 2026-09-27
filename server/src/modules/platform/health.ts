import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';

export async function platformHealth(database: Kysely<DB>) {
  const [queues, failedJobs, heartbeat, webhook] = await Promise.all([
    sql<{ name: string; pending: string; failed: string }>`
      SELECT q.name,
        count(j.id) FILTER (WHERE j.state IN ('created', 'retry'))::text AS pending,
        count(j.id) FILTER (WHERE j.state = 'failed')::text AS failed
      FROM pgboss.queue q LEFT JOIN pgboss.job j ON j.name = q.name
      GROUP BY q.name ORDER BY q.name
    `.execute(database),
    sql<{ id: string; name: string; created_on: Date }>`
      SELECT id, name, created_on FROM pgboss.job
      WHERE state = 'failed' ORDER BY created_on DESC LIMIT 20
    `.execute(database),
    sql<{ heartbeat_at: Date }>`
      SELECT heartbeat_at FROM worker_heartbeats
      WHERE stopped_at IS NULL ORDER BY heartbeat_at DESC LIMIT 1
    `.execute(database),
    sql<{ received_at: Date; processed_at: Date | null }>`
      SELECT received_at, processed_at FROM stripe_events
      ORDER BY received_at DESC LIMIT 1
    `.execute(database),
  ]);
  return {
    queues: queues.rows.map((row) => ({
      name: row.name,
      pending: Number(row.pending),
      failed: Number(row.failed),
    })),
    failedJobs: failedJobs.rows.map((row) => ({
      id: row.id,
      queue: row.name,
      createdAt: row.created_on.toISOString(),
    })),
    workerHeartbeatAt: heartbeat.rows[0]?.heartbeat_at.toISOString() ?? null,
    lastStripeWebhookReceivedAt:
      webhook.rows[0]?.received_at.toISOString() ?? null,
    lastStripeWebhookProcessedAt:
      webhook.rows[0]?.processed_at?.toISOString() ?? null,
  };
}
