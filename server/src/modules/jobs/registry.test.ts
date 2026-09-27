import { describe, expect, it } from 'vitest';

import { serverModules } from '../../generated/registry';
import type { ServerModule } from '../../lib/module-contract';

import {
  processCredentialExpiryForOrganizations,
  systemWorkerActorId,
} from './credentials-expiry';
import { moduleDefinition } from './module';
import { collectRegisteredJobs } from './registry';

describe('job registry', () => {
  it('accepts every generated module job at worker startup', () => {
    const jobs = collectRegisteredJobs(serverModules);
    const generatedJobsModule = serverModules.find(
      (module) => module.name === 'jobs',
    );
    const names = jobs.map((job) => job.name);
    const stripeEvent = jobs.find((job) => job.name === 'stripe.event');
    const alertCheck = jobs.find((job) => job.name === 'ops.alert-check');
    expect(names).toContain('communications.deliver-due');
    expect(stripeEvent?.name).toBe('stripe.event');
    expect(typeof stripeEvent?.run).toBe('function');
    expect(alertCheck).toMatchObject({
      name: 'ops.alert-check',
      cron: '* * * * *',
    });
    expect(generatedJobsModule?.publicRouter).toBe(
      moduleDefinition.publicRouter,
    );
  });

  it('collects executable jobs from module descriptors', async () => {
    const jobs = collectRegisteredJobs([moduleDefinition]);
    expect(jobs.map((job) => job.name)).toEqual([
      'jobs.probe',
      'ops.alert-check',
    ]);
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

  it('resolves the compliance expiry declaration into a daily executable job', async () => {
    const compliance = {
      name: 'compliance',
      path: '/api/v1/compliance',
      jobs: [{ name: 'credentials.expiry' }],
    } satisfies ServerModule;
    const [job] = collectRegisteredJobs([compliance]);
    expect(job).toMatchObject({
      name: 'credentials.expiry',
      cron: '0 14 * * *',
    });
    expect(typeof job?.run).toBe('function');
    const visited: string[] = [];
    const totals = await processCredentialExpiryForOrganizations(
      ['org-a', 'org-b'],
      (orgId, actorId) => {
        expect(actorId).toBe(systemWorkerActorId);
        visited.push(orgId);
        return Promise.resolve({ reminded: 1, expired: 2, demoted: 3 });
      },
    );
    expect(visited).toEqual(['org-a', 'org-b']);
    expect(totals).toEqual({ reminded: 2, expired: 4, demoted: 6 });
  });
});
