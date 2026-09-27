import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectOnboarding,
  type ConnectAccountView,
} from './ConnectOnboarding';

const disconnected: ConnectAccountView = {
  stripeAccountId: null,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirementsDue: [],
};
afterEach(cleanup);

describe('Connect onboarding panel', () => {
  it('uses a real account creation action before navigating to Stripe', async () => {
    const createAccount = vi
      .fn()
      .mockResolvedValue({ url: 'https://connect.stripe.com/setup' });
    const navigate = vi.fn();
    render(
      <ConnectOnboarding
        account={disconnected}
        actions={{
          createAccount,
          continueOnboarding: vi.fn(),
          openDashboard: vi.fn(),
        }}
        navigate={navigate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect Stripe' }));
    await waitFor(() => {
      expect(createAccount).toHaveBeenCalledTimes(1);
    });
    expect(navigate).toHaveBeenCalledWith('https://connect.stripe.com/setup');
  });

  it('rejects a non-Stripe destination instead of following it', async () => {
    const navigate = vi.fn();
    render(
      <ConnectOnboarding
        account={disconnected}
        actions={{
          createAccount: vi
            .fn()
            .mockResolvedValue({ url: 'https://example.test/collect' }),
          continueOnboarding: vi.fn(),
          openDashboard: vi.fn(),
        }}
        navigate={navigate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect Stripe' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'invalid destination',
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
