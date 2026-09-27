import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { BillingScreen } from './BillingScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const orgId = '11111111-1111-4111-8111-111111111111';
const planId = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockResolvedValue({
    plans: [{ id: planId, name: 'Club', monthlyPriceCents: 2500 }],
    subscription: null,
    checkout: null,
  });
});
afterEach(cleanup);

it('retries the same Checkout key and navigates only to Stripe Checkout', async () => {
  vi.mocked(apiPost)
    .mockRejectedValueOnce(new Error('Network unavailable'))
    .mockResolvedValueOnce({
      sessionId: 'cs_test_club',
      url: 'https://checkout.stripe.com/test/club',
    });
  const navigate = vi.fn();
  render(<BillingScreen orgId={orgId} navigate={navigate} />);
  const choose = await screen.findByRole('button', { name: 'Choose Club' });
  fireEvent.click(choose);
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Network unavailable',
  );
  fireEvent.click(choose);
  await waitFor(() => {
    expect(navigate).toHaveBeenCalledWith(
      'https://checkout.stripe.com/test/club',
    );
  });
  expect(vi.mocked(apiPost).mock.calls[0]?.[3]).toBe(
    vi.mocked(apiPost).mock.calls[1]?.[3],
  );
});

it('refuses a non-Stripe billing destination', async () => {
  vi.mocked(apiPost).mockResolvedValue({
    sessionId: 'cs_test_wrong',
    url: 'https://attacker.example/checkout',
  });
  const navigate = vi.fn();
  render(<BillingScreen orgId={orgId} navigate={navigate} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Club' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Stripe returned an unexpected destination',
  );
  expect(navigate).not.toHaveBeenCalled();
});

it('resumes a saved Checkout without creating a second session', async () => {
  vi.mocked(apiGet).mockResolvedValue({
    plans: [{ id: planId, name: 'Club', monthlyPriceCents: 2500 }],
    subscription: { planId: null, status: 'pending', currentPeriodEnd: null },
    checkout: {
      planId,
      status: 'created',
      url: 'https://checkout.stripe.com/test/resume',
    },
  });
  const navigate = vi.fn();
  render(<BillingScreen orgId={orgId} navigate={navigate} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Continue Stripe Checkout' }),
  );
  expect(navigate).toHaveBeenCalledWith(
    'https://checkout.stripe.com/test/resume',
  );
  expect(apiPost).not.toHaveBeenCalled();
});
