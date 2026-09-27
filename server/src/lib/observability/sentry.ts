import * as Sentry from '@sentry/node';

import { scrubSentryBreadcrumb, scrubSentryEvent } from './privacy';

let sentryEnabled = false;

export function initSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  const dsn = env.SENTRY_DSN;
  if (!dsn) return false;
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    throw new Error('SENTRY_DSN must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname)
    throw new Error('SENTRY_DSN must use HTTPS');
  Sentry.init({
    dsn,
    ...(env.NODE_ENV ? { environment: env.NODE_ENV } : {}),
    tracesSampleRate: 0,
    beforeSend: (event) => scrubSentryEvent(event) as typeof event | null,
    beforeBreadcrumb: () => scrubSentryBreadcrumb(),
  });
  sentryEnabled = true;
  return true;
}

export function captureOperationalAlert(
  signal:
    | 'worker_heartbeat_stale'
    | 'queue_backlog'
    | 'failed_jobs'
    | 'stripe_webhook_silence'
    | 'payment_failures'
    | 'email_bounces',
): void {
  if (sentryEnabled)
    Sentry.captureMessage(`athlentry.alert.${signal}`, 'error');
}

export function captureRedactedException(error: unknown): void {
  if (!sentryEnabled) return;
  Sentry.captureMessage(
    `athlentry.error.${error instanceof Error ? 'known' : 'unknown'}`,
    'error',
  );
}
