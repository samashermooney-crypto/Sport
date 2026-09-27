import { createHash } from 'node:crypto';

import {
  assertInvoiceLines,
  deriveInvoiceState,
} from '@shared/algorithms/invoice-state';

export type InvoiceLineKind =
  | 'registration'
  | 'add_on'
  | 'product'
  | 'team_fee'
  | 'tuition'
  | 'volunteer_buyout'
  | 'donation'
  | 'service_fee'
  | 'late_fee'
  | 'adjustment'
  | 'discount'
  | 'aid'
  | 'tax';

export interface NewInvoiceLine {
  kind: InvoiceLineKind;
  description: string;
  amountCents: number;
  refundable: boolean;
  taxRateBps?: number;
}

export interface IssueInvoiceInput {
  orgId: string;
  accountId: string;
  householdId?: string;
  source:
    | 'checkout'
    | 'staff'
    | 'installment_rollover'
    | 'team_fee'
    | 'tuition'
    | 'order'
    | 'donation';
  dueOn?: string;
  memo?: string;
  creationKey: string;
  lines: readonly NewInvoiceLine[];
}

export interface InvoiceTotals {
  subtotalCents: number;
  discountCents: number;
  serviceFeeCents: number;
  taxCents: number;
  totalCents: number;
}

function cents(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Invoice total exceeds safe integer cents');
  }
  return Number(value);
}

export function invoiceTotals(input: IssueInvoiceInput): InvoiceTotals {
  if (!input.lines.length)
    throw new Error('Invoice requires at least one line');
  let subtotal = 0n;
  let discount = 0n;
  let serviceFee = 0n;
  let tax = 0n;
  let absoluteSum = 0n;
  for (const line of input.lines) {
    if (!line.description.trim())
      throw new Error('Invoice line description is required');
    if (!Number.isSafeInteger(line.amountCents) || line.amountCents === 0) {
      throw new RangeError('Invoice line must be nonzero integer cents');
    }
    absoluteSum += BigInt(Math.abs(line.amountCents));
    if (line.kind === 'discount' || line.kind === 'aid') {
      if (line.amountCents >= 0)
        throw new RangeError('Discount/aid must be negative');
      discount -= BigInt(line.amountCents);
    } else {
      if (line.amountCents < 0)
        throw new RangeError('Charge line must be positive');
      if (line.kind === 'service_fee') serviceFee += BigInt(line.amountCents);
      else if (line.kind === 'tax') {
        if (input.source !== 'order')
          throw new Error('Tax applies only to product orders');
        tax += BigInt(line.amountCents);
      } else subtotal += BigInt(line.amountCents);
    }
  }
  cents(absoluteSum);
  const totalCents = cents(subtotal - discount + serviceFee + tax);
  assertInvoiceLines(totalCents, input.lines);
  return {
    subtotalCents: cents(subtotal),
    discountCents: cents(discount),
    serviceFeeCents: cents(serviceFee),
    taxCents: cents(tax),
    totalCents,
  };
}

export function invoiceRequestHash(input: IssueInvoiceInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        orgId: input.orgId,
        accountId: input.accountId,
        householdId: input.householdId ?? null,
        source: input.source,
        dueOn: input.dueOn ?? null,
        memo: input.memo ?? null,
        lines: input.lines,
      }),
    )
    .digest('hex');
}

export function initialInvoiceStatus(totalCents: number): 'open' | 'paid' {
  const state = deriveInvoiceState({
    totalCents,
    succeededAllocationsCents: 0,
    refundedToMethodCents: 0,
    creditAppliedCents: 0,
    todayLocal: '9999-12-31',
    confirmed: totalCents === 0,
    voided: false,
  });
  return state.status === 'paid' ? 'paid' : 'open';
}
