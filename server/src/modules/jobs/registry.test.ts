import { describe, expect, it } from 'vitest';

import type { ServerModule } from '../../lib/module-contract';

import { moduleDefinition } from './module';
import { collectRegisteredJobs } from './registry';

describe('job registry', () => {
  it('collects executable jobs from module descriptors', async () => {
    const jobs = collectRegisteredJobs([moduleDefinition]);
    expect(jobs.map((job) => job.name)).toEqual(['jobs.probe']);
    await expect(jobs[0]?.run({})).resolves.toEqual({ healthy: true });
  });

  it('rejects missing handlers, duplicate names and malformed schedules', () => {
    const missing = {
      name: 'missing',
      path: '/api/v1/missing',
      jobs: [{ name: 'missing.probe' }],
    } satisfies ServerModule;
    expect(() => collectRegisteredJobs([missing])).toThrow('no handler');
    expect(() =>
      collectRegisteredJobs([moduleDefinition, moduleDefinition]),
    ).toThrow('Duplicate');
    const malformed = {
      name: 'bad',
      path: '/api/v1/bad',
      jobs: [
        { name: 'bad.probe', run: () => Promise.resolve(undefined), cron: 1 },
      ],
    } as unknown as ServerModule;
    expect(() => collectRegisteredJobs([malformed])).toThrow('schedule');
  });
});
