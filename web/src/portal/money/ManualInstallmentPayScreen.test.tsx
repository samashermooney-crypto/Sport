import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { ManualInstallmentPayScreen } from './ManualInstallmentPayScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('./PaymentElementCheckout', () => ({
  PaymentElementCheckout: ({ quote }: { quote: { totalCents: number } }) => (
    <div>Secure form for {quote.totalCents} cents</div>
  ),
}));

const orgId = '11111111-1111-4111-8111-111111111111';
const installmentId = '22222222-2222-4222-8222-222222222222';
const invoiceId = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockImplementation((path) => {
    if (path === '/finance/stripe-client-config')
      return Promise.resolve({ publishableKey: 'pk_test_fixture' });
    return Promise.resolve({
      installments: [
        {
          id: installmentId,
          invoiceId,
          invoiceNumber: 42,
          dueOn: '2026-10-01',
          outstandingCents: 1000,
          status: 'scheduled',
        },
      ],
    });
  });
  vi.mocked(apiPost).mockResolvedValue({
    id: 'pi_test_manual',
    clientSecret: 'pi_test_manual_secret',
    status: 'requires_payment_method',
    amountCents: 1000,
    applicationFeeCents: 15,
  });
});
afterEach(cleanup);

it('uses one payer-owned installment amount and a stable payment key', async () => {
  render(<ManualInstallmentPayScreen orgId={orgId} />);
  await screen.findByRole('option', { name: /Invoice #42/ });
  fireEvent.change(screen.getByLabelText('Installment'), {
    target: { value: installmentId },
  });
  expect(screen.getByText(/including any service fee/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Continue to secure payment' }),
  );
  expect(await screen.findByText('Secure form for 1000 cents')).toBeTruthy();
  await waitFor(() => {
    expect(apiPost).toHaveBeenCalledWith(
      `/finance/orgs/${orgId}/me/installments/${installmentId}/payment-intents`,
      {},
      expect.anything(),
      expect.any(String),
    );
  });
});

it('refuses a server intent whose cents differ from the displayed installment', async () => {
  vi.mocked(apiPost).mockResolvedValue({
    id: 'pi_test_wrong',
    clientSecret: 'pi_test_wrong_secret',
    status: 'requires_payment_method',
    amountCents: 1001,
    applicationFeeCents: 15,
  });
  render(<ManualInstallmentPayScreen orgId={orgId} />);
  await screen.findByRole('option', { name: /Invoice #42/ });
  fireEvent.change(screen.getByLabelText('Installment'), {
    target: { value: installmentId },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Continue to secure payment' }),
  );
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Installment amount changed. Refresh before paying.',
  );
  expect(screen.queryByText(/Secure form for/)).toBeNull();
});
