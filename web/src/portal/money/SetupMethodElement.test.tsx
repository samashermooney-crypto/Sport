import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SetupMethodElement } from './SetupMethodElement';

const confirmSetup = vi.hoisted(() => vi.fn());
vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn().mockResolvedValue({}),
}));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PaymentElement: () => <div data-testid="setup-element" />,
  useStripe: () => ({ confirmSetup }),
  useElements: () => ({}),
}));

describe('saved method SetupIntent element', () => {
  it('accepts only test keys and fences ambiguous confirmation', async () => {
    expect(() =>
      SetupMethodElement({
        publishableKey: 'pk_live_bad',
        clientSecret: 'seti_secret',
        returnUrl: '/me/payments/return',
        onSaved: vi.fn(),
      }),
    ).toThrow();
    confirmSetup.mockRejectedValue(new Error('network lost'));
    render(
      <SetupMethodElement
        publishableKey="pk_test_fixture"
        clientSecret="seti_secret"
        returnUrl="/me/payments/return"
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Save payment method' }),
    );
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'status is unknown',
      );
    });
    expect(
      screen.queryByRole('button', { name: 'Save payment method' }),
    ).toBeNull();
  });
});
