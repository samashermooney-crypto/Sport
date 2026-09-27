import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { apiGet, apiPost } from '../../api/client';

import { InstallmentStaffScreen } from './InstallmentStaffScreen';

vi.mock('../../api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const orgId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';
const installmentId = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockResolvedValue({
    installments: [
      {
        id: installmentId,
        sequence: 1,
        dueOn: '2026-10-01',
        amountCents: 1000,
        paidCents: 0,
        status: 'scheduled',
        autopay: false,
        version: 1,
      },
    ],
    consents: [],
  });
  vi.mocked(apiPost).mockResolvedValue({
    installmentId,
    version: 2,
    dueOn: '2026-10-05',
    amountCents: 1000,
    addedInstallmentId: null,
    addedAmountCents: null,
  });
});
afterEach(cleanup);

it('submits an exact-version staff due-date action with a UUID retry key', async () => {
  render(<InstallmentStaffScreen orgId={orgId} invoiceId={invoiceId} />);
  expect(await screen.findByText(/paid \$0\.00/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Installment'), {
    target: { value: installmentId },
  });
  fireEvent.change(screen.getByLabelText('New due date'), {
    target: { value: '2026-10-05' },
  });
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Family requested an extension' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Record action' }));
  await waitFor(() => {
    expect(apiPost).toHaveBeenCalledWith(
      `/finance/orgs/${orgId}/installments/${installmentId}/actions`,
      {
        action: 'change_due_date',
        expectedVersion: 1,
        newDueOn: '2026-10-05',
        reason: 'Family requested an extension',
      },
      expect.anything(),
      expect.any(String),
    );
  });
});
