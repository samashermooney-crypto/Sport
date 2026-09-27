import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertInvoiceLines,
  assertPaymentAllocations,
  deriveInvoiceState,
  type InvoiceStateInput,
} from './invoice-state.js';

const base: InvoiceStateInput = {
  totalCents: 1000,
  succeededAllocationsCents: 0,
  refundedToMethodCents: 0,
  creditAppliedCents: 0,
  todayLocal: '2026-09-15',
  confirmed: false,
  voided: false,
};

describe('invoice state', () => {
  it('derives open, partial, overdue, paid and void states', () => {
    expect(deriveInvoiceState(base).status).toBe('open');
    expect(
      deriveInvoiceState({ ...base, succeededAllocationsCents: 500 }).status,
    ).toBe('partially_paid');
    expect(
      deriveInvoiceState({
        ...base,
        succeededAllocationsCents: 500,
        dueOn: '2026-09-14',
      }).status,
    ).toBe('past_due');
    expect(
      deriveInvoiceState({ ...base, succeededAllocationsCents: 1000 }).status,
    ).toBe('paid');
    expect(deriveInvoiceState({ ...base, voided: true }).status).toBe('void');
    expect(
      deriveInvoiceState({ ...base, totalCents: 0, confirmed: true }).status,
    ).toBe('paid');
  });

  it('subtracts method refunds and includes credit applications', () => {
    expect(
      deriveInvoiceState({
        ...base,
        succeededAllocationsCents: 600,
        refundedToMethodCents: 100,
        creditAppliedCents: 200,
      }),
    ).toMatchObject({ paidNetCents: 500, balanceCents: 300 });
  });

  it('fails closed on over-refunds, overpayment and voiding with money applied', () => {
    expect(() =>
      deriveInvoiceState({
        ...base,
        succeededAllocationsCents: 100,
        refundedToMethodCents: 101,
      }),
    ).toThrow();
    expect(() =>
      deriveInvoiceState({ ...base, succeededAllocationsCents: 1001 }),
    ).toThrow();
    expect(() =>
      deriveInvoiceState({
        ...base,
        succeededAllocationsCents: 1,
        voided: true,
      }),
    ).toThrow();
    expect(() =>
      deriveInvoiceState({
        ...base,
        installments: [
          { dueOn: '2026-09-01', amountCents: 100, paidCents: 101 },
        ],
      }),
    ).toThrow();
  });

  it('checks line, allocation and refund invariants', () => {
    expect(() => {
      assertInvoiceLines(100, [{ amountCents: 120 }, { amountCents: -20 }]);
    }).not.toThrow();
    expect(() => {
      assertInvoiceLines(100, [{ amountCents: 90 }]);
    }).toThrow();
    expect(() => {
      assertPaymentAllocations(100, [40, 60], [90, 11]);
    }).toThrow();
    expect(() => {
      assertPaymentAllocations(100, [40, 60], [90]);
    }).not.toThrow();
  });

  it('keeps balances within zero and total for valid inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (total, rawPaid) => {
          const paid = Math.min(total, rawPaid);
          const state = deriveInvoiceState({
            ...base,
            totalCents: total,
            succeededAllocationsCents: paid,
          });
          expect(state.balanceCents).toBeGreaterThanOrEqual(0);
          expect(state.balanceCents).toBeLessThanOrEqual(total);
        },
      ),
    );
  });

  it('marks overdue installments past due and rejects unreconciled money', () => {
    expect(
      deriveInvoiceState({
        ...base,
        installments: [
          { dueOn: '2026-09-01', amountCents: 1000, paidCents: 0 },
        ],
      }).status,
    ).toBe('past_due');
    expect(() => {
      assertInvoiceLines(100, [{ amountCents: 99.5 }, { amountCents: 0.5 }]);
    }).toThrow();
    expect(() => {
      assertPaymentAllocations(100, [99], []);
    }).toThrow();
  });
});
