import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { CheckoutReviewScreen } from './CheckoutReviewScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../PortalShell', () => ({
  PortalShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../money/CheckoutPaymentScreen', () => ({
  CheckoutPaymentScreen: ({
    quote,
  }: {
    quote: {
      totalCents: number;
      serviceFeeCents: number;
      lines: { amountCents: number }[];
    };
  }) => <div data-testid="payment-quote">{JSON.stringify(quote)}</div>,
}));

const orgId = '0199a413-a221-7000-8000-000000000011';
const checkoutId = '0199a413-a221-7000-8000-000000000012';
const invoiceId = '0199a413-a221-7000-8000-000000000013';
const termsHash = 'a'.repeat(64);
const terms = {
  policy: {
    rules: [{ throughDate: '2026-10-01', refundBps: 5000 }],
    afterLastBps: 0,
    serviceFeeRefund: 'proportional',
  },
  approvalThresholdCents: 10_000,
  refundApplicationFee: true,
};

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
  vi.mocked(apiGet).mockImplementation((path) => {
    if (path.endsWith('/refund-terms'))
      return Promise.resolve({ terms, termsHash, accepted: false });
    if (path === '/finance/stripe-client-config')
      return Promise.resolve({ publishableKey: 'pk_test_registration' });
    return Promise.resolve({
      checkoutId,
      expiresAt: '2026-10-01T12:00:00.000Z',
      status: 'open',
      cart: { offerings: [] },
    });
  });
  vi.mocked(apiPost).mockImplementation((path) => {
    if (path.endsWith('/refund-terms/accept'))
      return Promise.resolve({ terms, termsHash, accepted: true });
    return Promise.resolve({
      checkoutId,
      invoiceId,
      invoiceNumber: 42,
      totalCents: 2600,
      chargeNowCents: 2600,
      serviceFeeCents: 100,
      taxCents: 0,
      paidInFull: false,
      pendingApproval: false,
      plan: null,
      lines: [
        {
          kind: 'participant',
          description: 'Maya — Soccer',
          amountCents: 2500,
        },
        { kind: 'service_fee', description: 'Service fee', amountCents: 100 },
      ],
    });
  });
});
afterEach(cleanup);

describe('family registration payment review', () => {
  it('records exact refund-term acceptance before quoting and gives Payment Element one service fee', async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <CheckoutReviewScreen orgId={orgId} checkoutId={checkoutId} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText('Through 2026-10-01: 50% of eligible charges'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Continue to payment' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue to payment' }),
    );
    const payment = await screen.findByTestId('payment-quote');
    expect(JSON.parse(payment.textContent)).toEqual({
      lines: [{ id: '0', description: 'Maya — Soccer', amountCents: 2500 }],
      serviceFeeCents: 100,
      taxCents: 0,
      totalCents: 2600,
    });
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        `/registration/orgs/${orgId}/checkouts/${checkoutId}/refund-terms/accept`,
        { termsHash },
        expect.anything(),
      );
      expect(vi.mocked(apiPost).mock.calls[0]?.[0]).toContain(
        '/refund-terms/accept',
      );
      expect(vi.mocked(apiPost).mock.calls[1]?.[0]).toContain('/quote');
    });
  });

  it('confirms a zero-balance registration without requesting Stripe client configuration', async () => {
    vi.mocked(apiPost).mockImplementation((path) =>
      Promise.resolve(
        path.endsWith('/refund-terms/accept')
          ? { terms, termsHash, accepted: true }
          : {
              checkoutId,
              invoiceId,
              invoiceNumber: 43,
              totalCents: 0,
              chargeNowCents: 0,
              serviceFeeCents: 0,
              taxCents: 0,
              paidInFull: true,
              pendingApproval: false,
              plan: null,
              lines: [],
            },
      ),
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <CheckoutReviewScreen orgId={orgId} checkoutId={checkoutId} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText('Through 2026-10-01: 50% of eligible charges');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue to payment' }),
    );
    expect(await screen.findByText('Registration confirmed')).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalledWith(
      '/finance/stripe-client-config',
      expect.anything(),
    );
  });
});
