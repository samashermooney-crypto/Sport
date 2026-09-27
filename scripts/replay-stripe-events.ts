import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDatabase } from '../server/src/db/kysely.js';
import { runFinanceStripeReplayJob } from '../server/src/modules/finance/stripe-event-job.js';

export async function replayPendingStripeEvents(): Promise<number> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is required');
  if (process.env.NODE_ENV !== 'production' && !secret.startsWith('sk_test_'))
    throw new Error('Non-production Stripe replay requires a test-mode key');
  try {
    const result = await runFinanceStripeReplayJob();
    return result.processed;
  } finally {
    await getDatabase().destroy();
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  replayPendingStripeEvents()
    .then((count) =>
      process.stdout.write(`Stripe events replayed: ${String(count)}\n`),
    )
    .catch(() => {
      process.stderr.write(
        'Stripe event replay failed; inspect redacted job health.\n',
      );
      process.exitCode = 1;
    });
}
