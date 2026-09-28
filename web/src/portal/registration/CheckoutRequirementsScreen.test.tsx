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

import { CheckoutRequirementsScreen } from './CheckoutRequirementsScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../PortalShell', () => ({
  PortalShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const orgId = '0199a413-a221-7000-8000-000000000011';
const checkoutId = '0199a413-a221-7000-8000-000000000012';
const lineId = '0199a413-a221-7000-8000-000000000013';
const formId = '0199a413-a221-7000-8000-000000000014';
const waiverId = '0199a413-a221-7000-8000-000000000018';

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
  vi.mocked(apiGet).mockResolvedValue({
    checkoutId,
    status: 'open',
    lines: [
      {
        lineId,
        offeringId: '0199a413-a221-7000-8000-000000000015',
        offeringName: 'U12 Soccer',
        personId: '0199a413-a221-7000-8000-000000000016',
        personName: 'Maya One',
        requiresApproval: false,
        forms: [
          {
            formDefinitionId: formId,
            name: 'Player details',
            version: 1,
            fields: [{ key: 'jersey', label: 'Jersey number', required: true }],
            reusableAnswers: null,
          },
        ],
        waivers: [
          {
            waiverDocumentId: waiverId,
            name: 'Guardian and player waiver',
            version: 1,
            documentHash: 'a'.repeat(64),
            requires: 'both',
            bodyHtml: '<p>Both guardian and player agree.</p>',
          },
        ],
        addOns: [
          {
            key: 'uniform',
            name: 'Uniform',
            priceCents: 2500,
            required: true,
            sizes: ['Youth M', 'Youth L'],
            maxQuantity: 1,
          },
        ],
        volunteerRequirement: {
          required: true,
          buyoutCents: 5000,
          description: 'One shift or buyout',
        },
      },
    ],
    creditAvailableCents: 1200,
    installmentTemplates: [
      {
        id: '0199a413-a221-7000-8000-000000000017',
        name: 'Three payments',
        deposit: { kind: 'percent', bps: 3000 },
        schedule: { kind: 'monthly', count: 2, dayOfMonth: 1 },
        minAmountCents: 100,
        autopayRequired: false,
        allowedMethods: ['card'],
      },
    ],
    requirementsSubmitted: false,
  });
  vi.mocked(apiPost).mockResolvedValue({
    checkoutId,
    requirementsSubmitted: true,
  });
});

afterEach(cleanup);

describe('family registration requirements', () => {
  it('submits forms, required uniform choices, volunteer selection, credits, code and plan', async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <CheckoutRequirementsScreen orgId={orgId} checkoutId={checkoutId} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const jersey = await screen.findByLabelText('Jersey number *');
    fireEvent.change(jersey, { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Size'), {
      target: { value: 'Youth L' },
    });
    fireEvent.click(screen.getByLabelText('Pay the volunteer buyout'));
    fireEvent.change(screen.getByLabelText('Credit to apply (cents)'), {
      target: { value: '1200' },
    });
    fireEvent.change(screen.getByLabelText('Discount codes'), {
      target: { value: 'SIBLING' },
    });
    fireEvent.change(screen.getByLabelText('Installment plan'), {
      target: { value: '0199a413-a221-7000-8000-000000000017' },
    });
    fireEvent.click(
      screen.getByLabelText('I have read and agree to this waiver.'),
    );
    fireEvent.change(screen.getByLabelText('Guardian signer full name'), {
      target: { value: 'Family One' },
    });
    fireEvent.change(screen.getByLabelText('Participant signer full name'), {
      target: { value: 'Maya One' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalled();
    });
    const [, body] = vi.mocked(apiPost).mock.calls[0] ?? [];
    expect(body).toMatchObject({
      version: 1,
      lines: [
        {
          lineId,
          addOns: [{ key: 'uniform', quantity: 1, size: 'Youth L' }],
          volunteer: 'buyout',
        },
      ],
      forms: [{ lineId, formDefinitionId: formId, answers: { jersey: '10' } }],
      waivers: [
        {
          lineId,
          waiverDocumentId: waiverId,
          accepted: true,
          signerName: 'Family One',
          participantSignerName: 'Maya One',
        },
      ],
      discountCodes: ['SIBLING'],
      applyCreditCents: 1200,
      planTemplateId: '0199a413-a221-7000-8000-000000000017',
    });
  });
});
