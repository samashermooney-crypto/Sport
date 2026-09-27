import { createApp } from './app';
import { createLocalAuthDependencies } from './config';
import { createStripeWebhookRuntime } from './integrations/stripe/webhook-runtime';
import { writeStructuredLog } from './lib/observability/logging';
import { initSentry } from './lib/observability/sentry';
import { initializeFederationAdminDatabase } from './modules/federation/privileged';
import { initializePlatformAdminDatabase } from './modules/platform/admin';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';
initSentry();
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
    writeStructuredLog('info', 'api.ready', { module: 'api' });
  },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void (stripeWebhookRuntime?.stop() ?? Promise.resolve()).then(
        () => process.exit(0),
        () => {
          writeStructuredLog('error', 'api.shutdown_failed', {
            module: 'api',
            result: 'failed',
          });
          process.stderr.write('API shutdown failed\n');
          process.exit(1);
        },
      );
    });
  });
}
