import { createRequire } from 'node:module';

import { scrubSentryBreadcrumb, scrubSentryEvent } from './privacy';

type SentrySdk = {
  init(options: {
    dsn: string;
    environment?: string;
    sendDefaultPii: false;
    tracesSampleRate: number;
    beforeSend: (event: unknown) => unknown;
    beforeBreadcrumb: (breadcrumb: unknown) => null;
  }): void;
  captureMessage(message: string, level?: 'warning' | 'error'): string;
  captureException(error: unknown): string;
};

const requireFromHere = createRequire(import.meta.url);
let sentry: SentrySdk | undefined;

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
  let sdk: SentrySdk;
  try {
    sdk = requireFromHere('@sentry/node') as SentrySdk;
  } catch {
    throw new Error('SENTRY_DSN is set but @sentry/node is unavailable');
  }
  sdk.init({
    dsn,
    ...(env.NODE_ENV ? { environment: env.NODE_ENV } : {}),
    sendDefaultPii: false,
    tracesSampleRate: 0.05,
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  });
  sentry = sdk;
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
  sentry?.captureMessage(`athlentry.alert.${signal}`, 'error');
}

export function captureRedactedException(error: unknown): void {
  if (!sentry) return;
  sentry.captureMessage(
    `athlentry.error.${error instanceof Error ? 'known' : 'unknown'}`,
    'error',
  );
}
