import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { latestWorkerHeartbeat, listFailedJobs } from './health';

describe('job health reads', () => {
  it('limits and redacts failed-job listings', async () => {
    const calls: unknown[][] = [];
    const pool = {
      query: (_sql: string, params: unknown[]) => {
        calls.push(params);
        return Promise.resolve({
          rows: [
            {
              id: 'id',
              name: 'jobs.probe',
              created_on: new Date('2026-09-01T10:00:00Z'),
              completed_on: null,
              retry_count: 3,
              data: { secret: 'hidden' },
            },
          ],
        });
      },
    } as unknown as pg.Pool;
    expect(await listFailedJobs(pool, 10)).toEqual([
      {
        id: 'id',
        queue: 'jobs.probe',
        createdAt: '2026-09-01T10:00:00.000Z',
        completedAt: null,
        retryCount: 3,
      },
    ]);
    expect(calls).toEqual([[10]]);
    await expect(listFailedJobs(pool, 201)).rejects.toThrow();
  });

  it('returns the latest active worker timestamp', async () => {
    const pool = {
      query: () =>
        Promise.resolve({
          rows: [{ heartbeat_at: new Date('2026-09-01T10:00:00Z') }],
        }),
    } as unknown as pg.Pool;
    expect(await latestWorkerHeartbeat(pool)).toBe('2026-09-01T10:00:00.000Z');
  });
});
