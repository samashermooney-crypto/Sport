import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { PgBoss } from 'pg-boss';

import type { ServerModule } from '../../lib/module-contract';

import { collectRegisteredJobs } from './registry';

export type RunningWorker = {
  id: string;
  stop: () => Promise<void>;
};

export async function startRegisteredWorker(
  modules: readonly ServerModule[],
  connectionString: string,
): Promise<RunningWorker> {
  const jobs = collectRegisteredJobs(modules);
  const boss = new PgBoss({
    connectionString,
    migrate: false,
    createSchema: false,
  });
  const pool = new pg.Pool({ connectionString });
  const id = randomUUID();
  let timer: NodeJS.Timeout | undefined;
  try {
    await boss.start();
    for (const job of jobs) {
      await boss.createQueue(job.name, {
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
      });
      await boss.work(job.name, async (batch) => {
        const outputs = [];
        for (const item of batch) outputs.push(await job.run(item.data));
        return outputs;
      });
      if (job.cron) await boss.schedule(job.name, job.cron);
    }
    await pool.query('INSERT INTO worker_heartbeats(worker_id) VALUES ($1)', [
      id,
    ]);
    timer = setInterval(() => {
      void pool
        .query(
          'UPDATE worker_heartbeats SET heartbeat_at = now() WHERE worker_id = $1 AND stopped_at IS NULL',
          [id],
        )
        .catch(() => undefined);
    }, 30_000);
    return {
      id,
      stop: async () => {
        if (timer) clearInterval(timer);
        await pool.query(
          'UPDATE worker_heartbeats SET stopped_at = now() WHERE worker_id = $1',
          [id],
        );
        await boss.stop({ graceful: true, timeout: 30_000 });
        await pool.end();
      },
    };
  } catch (error) {
    if (timer) clearInterval(timer);
    await boss.stop().catch(() => undefined);
    await pool.end();
    throw error;
  }
}
