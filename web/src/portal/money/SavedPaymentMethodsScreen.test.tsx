import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SavedPaymentMethodsScreen } from './SavedPaymentMethodsScreen';

const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
const apiDelete = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ apiGet, apiPost, apiDelete }));
vi.mock('./SetupMethodElement', () => ({
  SetupMethodElement: ({
    onSaved,
  }: {
    onSaved: (status: 'succeeded') => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onSaved('succeeded');
      }}
    >
      Confirm setup
    </button>
  ),
}));

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiDelete.mockReset();
  sessionStorage.clear();
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('saved payment methods screen', () => {
  it('loads, sets a default, removes a method and creates a SetupIntent', async () => {
    const method = {
      id: 'pm_test',
      type: 'card',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      bankName: null,
    };
    apiGet.mockResolvedValue({ methods: [method], defaultMethodId: null });
    apiPost.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/default')
          ? { success: true }
          : { id: 'seti_test', clientSecret: 'seti_secret' },
      ),
    );
    apiDelete.mockResolvedValue({ success: true });
    render(
      <SavedPaymentMethodsScreen
        publishableKey="pk_test_fixture"
        returnUrl="/me/payments/return"
      />,
    );
    expect(await screen.findByText('visa ending 4242')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make default' }));
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        '/finance/me/payment-methods/pm_test/default',
        {},
        expect.anything(),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(apiDelete).toHaveBeenCalledWith(
        '/finance/me/payment-methods/pm_test',
        expect.anything(),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add payment method' }));
    expect(
      await screen.findByRole('button', { name: 'Confirm setup' }),
    ).toBeTruthy();
    expect(apiPost).toHaveBeenCalledWith(
      '/finance/me/setup-intents',
      {},
      expect.anything(),
      expect.any(String),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm setup' }));
    await waitFor(() => {
      expect(screen.getByText('Payment method saved.')).toBeTruthy();
    });
  });
});
