import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { StorePortal } from './StorePortal';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const orgId = '0199a413-a221-7000-8000-000000000011';
const householdId = '0199a413-a221-7000-8000-000000000012';
const athleteId = '0199a413-a221-7000-8000-000000000013';
const registrationId = '0199a413-a221-7000-8000-000000000014';
const secondRegistrationId = '0199a413-a221-7000-8000-000000000015';
const productId = '0199a413-a221-7000-8000-000000000016';
const variantId = '0199a413-a221-7000-8000-000000000017';

const registration = {
  id: registrationId,
  personId: athleteId,
  personName: 'Taylor Uniform',
  programId: '0199a413-a221-7000-8000-000000000018',
  programName: 'Fall Soccer',
  offeringId: '0199a413-a221-7000-8000-000000000019',
  offeringName: 'U12 League',
  status: 'confirmed',
  statusReason: null,
  checkoutId: null,
  invoiceId: null,
  approvalPaymentDueAt: null,
  createdAt: '2026-09-20T12:00:00.000Z',
};

function renderStorePortal(): void {
  render(<StorePortal orgId={orgId} />);
}

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
  vi.mocked(apiGet).mockImplementation((path) => {
    if (path.endsWith('/products'))
      return Promise.resolve({
        products: [
          {
            id: productId,
            name: 'Team uniform',
            description: null,
            categoryId: null,
            categoryName: null,
            kind: 'uniform',
            requiredForRegistration: true,
            active: true,
            variants: [
              {
                id: variantId,
                sku: 'TEAM-YM',
                size: 'Youth Medium',
                color: null,
                priceCents: 4500,
                taxRateId: null,
                onHand: 2,
                reserved: 0,
                available: 2,
                lowStockThreshold: null,
              },
            ],
          },
        ],
      });
    if (path.includes('/me/households'))
      return Promise.resolve({
        households: [
          {
            id: householdId,
            personIds: [athleteId],
            people: [{ id: athleteId, name: 'Taylor Uniform' }],
          },
        ],
      });
    if (path.endsWith('/me/orders')) return Promise.resolve({ orders: [] });
    if (path.endsWith('/me/registrations'))
      return Promise.resolve({ registrations: [registration] });
    return Promise.reject(new Error(`Unexpected GET ${path}`));
  });
  vi.mocked(apiPost).mockResolvedValue({
    id: '0199a413-a221-7000-8000-000000000020',
    status: 'awaiting_payment',
    invoiceId: '0199a413-a221-7000-8000-000000000021',
    subtotalCents: 4500,
    taxCents: 0,
  });
});

afterEach(cleanup);

describe('family store registration attribution', () => {
  it('selects the athlete’s unique active registration and includes it with the order', async () => {
    renderStorePortal();

    await screen.findByRole('heading', { name: 'Uniforms and spirit wear' });
    const registrationSelect =
      await screen.findByLabelText<HTMLSelectElement>('Registration');
    await waitFor(() => {
      expect(registrationSelect.value).toBe(registrationId);
    });
    fireEvent.change(screen.getByLabelText('Team uniform size'), {
      target: { value: variantId },
    });
    fireEvent.change(screen.getByLabelText('Quantity'), {
      target: { value: '1' },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Place order and create invoice',
      }),
    );

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(
        `/store/orgs/${orgId}/orders`,
        expect.objectContaining({
          householdId,
          registrationId,
          fulfillmentMethod: 'pickup',
          lines: [{ variantId, quantity: 1, personId: athleteId }],
        }),
        expect.anything(),
        expect.stringMatching(/^[0-9a-f-]{36}$/i),
      );
    });
  });

  it('does not guess when the athlete has more than one active registration', async () => {
    vi.mocked(apiGet).mockImplementation((path) => {
      if (path.endsWith('/products')) return Promise.resolve({ products: [] });
      if (path.includes('/me/households'))
        return Promise.resolve({
          households: [
            {
              id: householdId,
              personIds: [athleteId],
              people: [{ id: athleteId, name: 'Taylor Uniform' }],
            },
          ],
        });
      if (path.endsWith('/me/orders')) return Promise.resolve({ orders: [] });
      if (path.endsWith('/me/registrations'))
        return Promise.resolve({
          registrations: [
            registration,
            {
              ...registration,
              id: secondRegistrationId,
              programName: 'Spring Soccer',
            },
          ],
        });
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    });

    renderStorePortal();

    const registrationSelect =
      await screen.findByLabelText<HTMLSelectElement>('Registration');
    expect(registrationSelect.value).toBe('');
    fireEvent.change(registrationSelect, {
      target: { value: secondRegistrationId },
    });
    expect(registrationSelect.value).toBe(secondRegistrationId);
  });
});
