import { afterEach, describe, expect, it, vi } from 'vitest';

import { replayPendingStripeEvents } from '../../../scripts/replay-stripe-events';
import { runFinanceStripeReplayJob } from '../../src/modules/finance/stripe-event-job';

vi.mock('../../src/modules/finance/stripe-event-job', () => ({
  runFinanceStripeReplayJob: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(runFinanceStripeReplayJob).mockReset();
});

describe('Stripe event replay operator command', () => {
  it('requires a database and a test-mode key outside production', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://athlentry_app@127.0.0.1/test');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_ops_fixture');
    vi.stubEnv('NODE_ENV', 'development');
    vi.mocked(runFinanceStripeReplayJob).mockResolvedValue({ processed: 0 });
    await expect(replayPendingStripeEvents()).resolves.toBe(0);

    vi.stubEnv('STRIPE_SECRET_KEY', 'not-a-test-key');
    await expect(replayPendingStripeEvents()).rejects.toThrow(
      'Non-production Stripe replay requires a test-mode key',
    );

    vi.stubEnv('DATABASE_URL', '');
    await expect(replayPendingStripeEvents()).rejects.toThrow(
      'DATABASE_URL is required',
    );
  });

  it('returns only the replay count from the existing dispatcher', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://athlentry_app@127.0.0.1/test');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_ops_fixture');
    vi.stubEnv('NODE_ENV', 'test');
    vi.mocked(runFinanceStripeReplayJob).mockResolvedValue({ processed: 7 });

    await expect(replayPendingStripeEvents()).resolves.toBe(7);
    expect(runFinanceStripeReplayJob).toHaveBeenCalledOnce();
  });
});
