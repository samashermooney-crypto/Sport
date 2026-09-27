import type pg from 'pg';

export type FailedJobSummary = {
  id: string;
  queue: string;
  createdAt: string;
  completedAt: string | null;
  retryCount: number;
};

export async function listFailedJobs(
  pool: pg.Pool,
  limit = 50,
): Promise<FailedJobSummary[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError('Failed-job limit must be 1–200');
  const result = await pool.query<{
    id: string;
    name: string;
    created_on: Date;
    completed_on: Date | null;
    retry_count: number;
  }>(
    `SELECT id, name, created_on, completed_on, retry_count
      FROM pgboss.job WHERE state = 'failed'
      ORDER BY created_on DESC, id DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    queue: row.name,
    createdAt: row.created_on.toISOString(),
    completedAt: row.completed_on?.toISOString() ?? null,
    retryCount: row.retry_count,
  }));
}

export async function latestWorkerHeartbeat(
  pool: pg.Pool,
): Promise<string | null> {
  const result = await pool.query<{ heartbeat_at: Date }>(
    `SELECT heartbeat_at FROM worker_heartbeats
      WHERE stopped_at IS NULL ORDER BY heartbeat_at DESC LIMIT 1`,
  );
  return result.rows[0]?.heartbeat_at.toISOString() ?? null;
}
