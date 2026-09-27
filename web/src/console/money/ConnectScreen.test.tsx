import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectRefresh, ConnectScreen } from './ConnectScreen';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Connected finance screen', () => {
  it('loads status and follows a verified Stripe onboarding link', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            stripeAccountId: null,
            chargesEnabled: false,
            payoutsEnabled: false,
            detailsSubmitted: false,
            requirementsDue: [],
            disabledReason: null,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            url: 'https://connect.stripe.com/onboard/test',
          }),
      });
    vi.stubGlobal('fetch', fetcher);
    const navigate = vi.fn();
    render(<ConnectScreen orgId="org-1" navigate={navigate} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Connect Stripe' }),
    );
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        'https://connect.stripe.com/onboard/test',
      );
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      '/api/v1/finance/orgs/org-1/connect/status',
    );
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      '/api/v1/finance/orgs/org-1/connect/onboarding',
    );
  });

  it('refresh target requests a fresh Stripe link once', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ url: 'https://connect.stripe.com/onboard/fresh' }),
    });
    vi.stubGlobal('fetch', fetcher);
    const navigate = vi.fn();
    render(<ConnectRefresh orgId="org-1" navigate={navigate} />);
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        'https://connect.stripe.com/onboard/fresh',
      );
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
