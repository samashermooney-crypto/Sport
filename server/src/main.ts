import { createApp } from './app';
import { createLocalAuthDependencies } from './config';
import { createStripeWebhookRuntime } from './integrations/stripe/webhook-runtime';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';
const auth = await createLocalAuthDependencies();
const stripeWebhookRuntime = await createStripeWebhookRuntime();
const server = createApp(auth, stripeWebhookRuntime?.dependencies).listen(
  port,
  host,
  () => {
    process.stdout.write(
      `Athlentry API listening on http://${host}:${String(port)}\n`,
    );
  },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void (stripeWebhookRuntime?.stop() ?? Promise.resolve()).then(
        () => process.exit(0),
        (error: unknown) => {
          process.stderr.write(
            `${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exit(1);
        },
      );
    });
  });
}
