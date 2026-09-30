import express from 'express';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { DB } from '../../db/types';
import {
  publicStatus,
  readinessResponse,
} from '../../lib/observability/health';

const workerHeartbeatMaxAgeMs = 90_000;

export function createOperationalHealthRouter(database: Kysely<DB>) {
  const router = express.Router();

  router.get('/readyz', async (_request, response) => {
    try {
      await sql`SELECT 1`.execute(database);
      response.status(200).json(readinessResponse(true));
    } catch {
      response.status(503).json(readinessResponse(false));
    }
  });

  router.get('/status', async (_request, response) => {
    let databaseAvailable = false;
    let workerAvailable = false;
    try {
      await sql`SELECT 1`.execute(database);
      databaseAvailable = true;
    } catch {
      /* The public response reports state only, never internal errors. */
    }
    if (databaseAvailable) {
      try {
        const result = await sql<{ heartbeat_at: Date }>`
          SELECT heartbeat_at FROM worker_heartbeats
          WHERE stopped_at IS NULL
          ORDER BY heartbeat_at DESC
          LIMIT 1
        `.execute(database);
        const heartbeatAt = result.rows[0]?.heartbeat_at;
        if (heartbeatAt) {
          const age = Date.now() - heartbeatAt.getTime();
          workerAvailable = age >= 0 && age <= workerHeartbeatMaxAgeMs;
        }
      } catch {
        /* Missing or unavailable worker state is reported as degraded. */
      }
    }
    response.json(
      publicStatus({
        api: true,
        database: databaseAvailable,
        worker: workerAvailable,
      }),
    );
  });

  return router;
}
