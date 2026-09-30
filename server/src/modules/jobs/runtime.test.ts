import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { DB } from '../../db/types';
import { MemoryStorage } from '../../integrations/storage/storage';
import type { JobRuntimeDependencies } from '../../lib/module-contract';

import type { RegisteredJob } from './registry';
import { runRegisteredJobBatch } from './runtime';

describe('registered job runtime', () => {
  it('passes configured storage and organization dependencies to each job', async () => {
    const storage = new MemoryStorage();
    const dependencies: JobRuntimeDependencies = {
      database: {} as Kysely<DB>,
      storage,
      now: new Date('2026-09-29T18:00:00.000Z'),
      runWithOrg: (() =>
        Promise.resolve()) as JobRuntimeDependencies['runWithOrg'],
    };
    const received: JobRuntimeDependencies[] = [];
    const job: RegisteredJob = {
      name: 'exports.build-org',
      run: (data, jobDependencies) => {
        received.push(jobDependencies);
        return Promise.resolve(data);
      },
    };

    await expect(
      runRegisteredJobBatch(
        job,
        [{ data: 'first' }, { data: 'second' }],
        dependencies,
      ),
    ).resolves.toEqual(['first', 'second']);
    expect(received).toEqual([dependencies, dependencies]);
    expect(received[0]?.storage).toBe(storage);
  });
});
