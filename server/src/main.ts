import { createApp } from './app';
import { createLocalAuthDependencies } from './config';
import { createStripeWebhookRuntime } from './integrations/stripe/webhook-runtime';
import { writeStructuredLog } from './lib/observability/logging';
import {
  captureRedactedException,
  initSentry,
} from './lib/observability/sentry';
import { initializeFederationAdminDatabase } from './modules/federation/privileged';
import { closeFederationAdminDatabase } from './modules/federation/privileged';
import {
  closePlatformAdminDatabase,
  initializePlatformAdminDatabase,
} from './modules/platform/admin';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '127.0.0.1';
  initSentry();
  writeStructuredLog('info', 'api.starting');
  const auth = await createLocalAuthDependencies();
  if ((process.env.ATHLENTRY_PROCESS_TYPE ?? 'web') === 'web') {
    initializeFederationAdminDatabase();
    initializePlatformAdminDatabase();
    delete process.env.DATABASE_ADMIN_URL;
  }
  const stripeWebhookRuntime = await createStripeWebhookRuntime();
  const server = createApp(auth, stripeWebhookRuntime?.dependencies).listen(
    port,
    host,
    () => {
      writeStructuredLog('info', 'api.listening', {
        operation: `port.${String(port)}`,
      });
    },
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => {
        void Promise.all([
          stripeWebhookRuntime?.stop() ?? Promise.resolve(),
          closeFederationAdminDatabase(),
          closePlatformAdminDatabase(),
        ]).then(
          () => process.exit(0),
          (error: unknown) => {
            captureRedactedException(error);
            writeStructuredLog('error', 'api.stop.failed', {
              result: 'failed',
            });
            process.exit(1);
          },
        );
      });
    });
  }
}

await main().catch((error: unknown) => {
  captureRedactedException(error);
  writeStructuredLog('error', 'api.start.failed', { result: 'failed' });
  process.exitCode = 1;
});
