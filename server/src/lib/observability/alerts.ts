export type OperationalMetrics = {
  now: Date;
  workerHeartbeatAt: Date | null;
  pendingJobs: number;
  backlogOverThresholdSince: Date | null;
  failedJobs: number;
  lastSuccessfulChargeAt: Date | null;
  lastStripeWebhookAt: Date | null;
  paymentAttempts15m: number;
  paymentFailures15m: number;
  emails30m: number;
  emailBounces30m: number;
};

export type OperationalSignal =
  | 'worker_heartbeat_stale'
  | 'queue_backlog'
  | 'failed_jobs'
  | 'stripe_webhook_silence'
  | 'payment_failures'
  | 'email_bounces';

const minute = 60_000;
const day = 24 * 60 * minute;

export function evaluateOperationalAlerts(
  metrics: OperationalMetrics,
): OperationalSignal[] {
  const alerts: OperationalSignal[] = [];
  if (
    !metrics.workerHeartbeatAt ||
    metrics.now.getTime() - metrics.workerHeartbeatAt.getTime() > 90_000
  ) {
    alerts.push('worker_heartbeat_stale');
  }
  if (
    metrics.pendingJobs > 1_000 &&
    metrics.backlogOverThresholdSince !== null &&
    metrics.now.getTime() - metrics.backlogOverThresholdSince.getTime() >=
      5 * minute
  ) {
    alerts.push('queue_backlog');
  }
  if (metrics.failedJobs > 0) alerts.push('failed_jobs');
  if (
    metrics.lastSuccessfulChargeAt &&
    metrics.now.getTime() - metrics.lastSuccessfulChargeAt.getTime() <= day &&
    (!metrics.lastStripeWebhookAt ||
      metrics.now.getTime() - metrics.lastStripeWebhookAt.getTime() > day)
  ) {
    alerts.push('stripe_webhook_silence');
  }
  if (
    metrics.paymentAttempts15m >= 20 &&
    metrics.paymentFailures15m / metrics.paymentAttempts15m > 0.05
  ) {
    alerts.push('payment_failures');
  }
  if (
    metrics.emails30m >= 100 &&
    metrics.emailBounces30m / metrics.emails30m > 0.05
  ) {
    alerts.push('email_bounces');
  }
  return alerts;
}
