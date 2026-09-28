import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  PaymentElementCheckout,
  assertPaymentQuote,
  assertTestPublishableKey,
  type PaymentQuote,
} from './PaymentElementCheckout';

const confirmPayment = vi.hoisted(() => vi.fn());
vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn().mockResolvedValue({}),
}));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({
    children,
    options,
  }: {
    children: React.ReactNode;
    options?: { customerSessionClientSecret?: string };
  }) => (
    <div
      data-testid="elements"
      data-customer-session={options?.customerSessionClientSecret ?? ''}
    >
      {children}
    </div>
  ),
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment }),
  useElements: () => ({}),
}));

const quote: PaymentQuote = {
  lines: [
    { id: 'registration', description: 'Registration', amountCents: 5000 },
  ],
  serviceFeeCents: 180,
  taxCents: 0,
  totalCents: 5180,
};

describe('Payment Element checkout', () => {
  it('fails closed for live keys and inconsistent quote cents', () => {
    expect(() => {
      assertTestPublishableKey('pk_live_example');
    }).toThrow();
    expect(() => {
      assertPaymentQuote({ ...quote, totalCents: 5179 });
    }).toThrow();
    expect(() => {
      assertPaymentQuote(quote);
    }).not.toThrow();
  });

  it('shows the method-independent service fee and honest ACH processing state', async () => {
    confirmPayment.mockResolvedValue({
      paymentIntent: { status: 'processing' },
    });
    const onSubmitted = vi.fn();
    render(
      <PaymentElementCheckout
        publishableKey="pk_test_fixture"
        clientSecret="pi_test_secret"
        customerSessionClientSecret="cuss_test_secret"
        quote={quote}
        returnUrl="/me/payments/return"
        onSubmitted={onSubmitted}
      />,
    );
    expect(screen.getByText('Service fee')).toBeDefined();
    expect(screen.getByText('$1.80')).toBeDefined();
    expect(screen.getByTestId('payment-element')).toBeDefined();
    expect(
      screen.getByTestId('elements').getAttribute('data-customer-session'),
    ).toBe('cuss_test_secret');
    fireEvent.click(screen.getByRole('button', { name: 'Pay $51.80' }));
    await waitFor(() => {
      expect(onSubmitted).toHaveBeenCalledWith('processing');
    });
    expect(screen.getByRole('status').textContent).toContain('processing');
    expect(confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        redirect: 'if_required',
        confirmParams: {
          return_url: `${window.location.origin}/me/payments/return`,
        },
      }),
    );
  });

  it('does not offer an immediate second submission after an ambiguous Stripe failure', async () => {
    confirmPayment.mockRejectedValue(new Error('connection lost'));
    render(
      <PaymentElementCheckout
        publishableKey="pk_test_fixture"
        clientSecret="pi_test_secret"
        quote={quote}
        returnUrl="/me/payments/return"
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pay $51.80' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'status is unknown',
      );
    });
    expect(screen.queryByRole('button', { name: 'Pay $51.80' })).toBeNull();
  });
});
