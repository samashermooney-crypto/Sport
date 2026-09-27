import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CheckoutPaymentScreen } from './CheckoutPaymentScreen';

const apiPost = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ apiPost }));
vi.mock('./PaymentElementCheckout', () => ({
  assertPaymentQuote: (quote: { totalCents: number }) => {
    if (quote.totalCents !== 1000) throw new Error('Invalid quote');
  },
  PaymentElementCheckout: ({ clientSecret }: { clientSecret: string }) => (
    <p data-testid="element">{clientSecret}</p>
  ),
}));

const quote = {
  lines: [
    { id: 'registration', description: 'Registration', amountCents: 1000 },
  ],
  serviceFeeCents: 0,
  taxCents: 0,
  totalCents: 1000,
};
const props = {
  orgId: 'org-id',
  checkoutId: 'checkout-id',
  invoiceId: 'invoice-id',
  publishableKey: 'pk_test_fixture',
  quote,
  returnUrl: '/payment/return',
  onSubmitted: vi.fn(),
};

beforeEach(() => {
  apiPost.mockReset();
  sessionStorage.clear();
});
afterEach(cleanup);

describe('checkout payment screen', () => {
  it('retries with the same key and shows only the reconciled Stripe secret', async () => {
    apiPost
      .mockRejectedValueOnce(new Error('Temporary error'))
      .mockResolvedValueOnce({
        id: 'pi_test',
        clientSecret: 'pi_test_secret',
        status: 'requires_payment_method',
        quote: {
          baseCents: 1000,
          serviceFeeCents: 0,
          taxCents: 0,
          amountCents: 1000,
          applicationFeeCents: 15,
        },
      });
    render(<CheckoutPaymentScreen {...props} />);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Temporary');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry payment' }));
    await waitFor(() => {
      expect(screen.getByTestId('element').textContent).toBe('pi_test_secret');
    });
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(apiPost.mock.calls[0]?.[3]).toBe(apiPost.mock.calls[1]?.[3]);
  });

  it('rejects a server amount that differs from the displayed quote', async () => {
    apiPost.mockResolvedValue({
      id: 'pi_test',
      clientSecret: 'pi_test_secret',
      status: 'requires_payment_method',
      quote: {
        baseCents: 1001,
        serviceFeeCents: 0,
        taxCents: 0,
        amountCents: 1001,
        applicationFeeCents: 15,
      },
    });
    render(<CheckoutPaymentScreen {...props} />);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('amount changed');
    });
    expect(screen.queryByTestId('element')).toBeNull();
  });
});
