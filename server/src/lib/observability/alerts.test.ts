import { describe, expect, it } from 'vitest';

import { evaluateOperationalAlerts } from './alerts';
import {
  createOperationalAlertReporter,
  nextBacklogThresholdStart,
} from './monitor';

const now = new Date('2026-09-27T15:00:00.000Z');

describe('operational alert thresholds', () => {
  it('keeps queue duration only while backlog stays above the threshold', () => {
    const first = nextBacklogThresholdStart(1_001, null, now);
    expect(first).toEqual(now);
    expect(nextBacklogThresholdStart(1_500, first, now)).toBe(first);
    expect(nextBacklogThresholdStart(1_000, first, now)).toBeNull();
  });

  it('reports alert transitions once until a condition clears', () => {
    const reported: string[] = [];
    const report = createOperationalAlertReporter((signal) => {
      reported.push(signal);
    });
    report(['failed_jobs']);
    report(['failed_jobs']);
    report([]);
    report(['failed_jobs']);
    expect(reported).toEqual(['failed_jobs', 'failed_jobs']);
  });

  it('alerts for stale workers, sustained queue backlog, failed jobs and silent webhooks', () => {
    expect(
      evaluateOperationalAlerts({
        now,
        workerHeartbeatAt: new Date(now.getTime() - 91_000),
        pendingJobs: 1_001,
        backlogOverThresholdSince: new Date(now.getTime() - 5 * 60_000),
        failedJobs: 1,
        lastSuccessfulChargeAt: new Date(now.getTime() - 60_000),
        lastStripeWebhookAt: null,
        paymentAttempts15m: 0,
        paymentFailures15m: 0,
        emails30m: 0,
        emailBounces30m: 0,
      }),
    ).toEqual([
      'worker_heartbeat_stale',
      'queue_backlog',
      'failed_jobs',
      'stripe_webhook_silence',
    ]);
  });

  it('requires minimum volume and clears metrics below thresholds', () => {
    expect(
      evaluateOperationalAlerts({
        now,
        workerHeartbeatAt: new Date(now.getTime() - 30_000),
        pendingJobs: 1_000,
        backlogOverThresholdSince: null,
        failedJobs: 0,
        lastSuccessfulChargeAt: null,
        lastStripeWebhookAt: null,
        paymentAttempts15m: 19,
        paymentFailures15m: 10,
        emails30m: 99,
        emailBounces30m: 20,
      }),
    ).toEqual([]);
  });

  it('flags payment and bounce rates only when their minimum sample is reached', () => {
    expect(
      evaluateOperationalAlerts({
        now,
        workerHeartbeatAt: now,
        pendingJobs: 0,
        backlogOverThresholdSince: null,
        failedJobs: 0,
        lastSuccessfulChargeAt: null,
        lastStripeWebhookAt: null,
        paymentAttempts15m: 20,
        paymentFailures15m: 2,
        emails30m: 100,
        emailBounces30m: 6,
      }),
    ).toEqual(['payment_failures', 'email_bounces']);
  });
});
