import { PgBoss } from 'pg-boss';

import { getDatabase } from '../../db/kysely.js';

import { PostgresStripeEventRepository } from './repo.js';
import { createStripeGateway } from './sdk.js';
import type { StripeWebhookDependencies } from './webhook-routes.js';

export interface StripeWebhookRuntime {
  dependencies: StripeWebhookDependencies;
  stop: () => Promise<void>;
}

/** Configure Stripe ingress only when the complete test-mode webhook setup exists. */
export async function createStripeWebhookRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StripeWebhookRuntime | null> {
  const secretKey = env.STRIPE_SECRET_KEY;
  const platformSecret = env.STRIPE_WEBHOOK_SECRET;
  const connectSecret = env.STRIPE_CONNECT_WEBHOOK_SECRET;
  const configured = [secretKey, platformSecret, connectSecret].some((value) =>
    Boolean(value),
  );
  if (!configured) return null;
  if (
    !secretKey?.startsWith('sk_test_') ||
    !platformSecret?.startsWith('whsec_') ||
    !connectSecret?.startsWith('whsec_')
  ) {
    throw new Error('Stripe test webhook configuration is incomplete');
  }

  const connectionString =
    env.DATABASE_URL ?? 'postgres://athlentry_app@127.0.0.1:5432/athlentry_dev';
  const boss = new PgBoss({
    connectionString,
    migrate: false,
    createSchema: false,
  });
  await boss.start();
  try {
    await boss.createQueue('stripe.event');
  } catch (error) {
    await boss.stop().catch(() => undefined);
    throw error;
  }

  return {
    dependencies: {
      gateway: createStripeGateway(secretKey),
      repository: new PostgresStripeEventRepository(getDatabase()),
      enqueue: async (eventId) => {
        await boss.send('stripe.event', { eventId });
      },
      platformSecret,
      connectSecret,
    },
    stop: () => boss.stop(),
  };
}
