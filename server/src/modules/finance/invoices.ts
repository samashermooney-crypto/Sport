import { createHash } from 'node:crypto';

import {
  assertInvoiceLines,
  deriveInvoiceState,
} from '@shared/algorithms/invoice-state';
import { percentOf } from '@shared/money';

import type { RefundTerms } from './refund-terms.js';

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
  parentLineIndex?: number;
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
  refundTerms?: RefundTerms;
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
  let productSubtotal = 0n;
  let taxLine: NewInvoiceLine | null = null;
  const discountByParent = new Map<number, bigint>();
  for (const [index, line] of input.lines.entries()) {
    if (!line.description.trim())
      throw new Error('Invoice line description is required');
    if (!Number.isSafeInteger(line.amountCents) || line.amountCents === 0) {
      throw new RangeError('Invoice line must be nonzero integer cents');
    }
    absoluteSum += BigInt(Math.abs(line.amountCents));
    if (line.kind === 'discount' || line.kind === 'aid') {
      if (line.amountCents >= 0)
        throw new RangeError('Discount/aid must be negative');
      const parent =
        line.parentLineIndex === undefined
          ? null
          : input.lines[line.parentLineIndex];
      if (
        !Number.isInteger(line.parentLineIndex) ||
        line.parentLineIndex === undefined ||
        line.parentLineIndex < 0 ||
        line.parentLineIndex >= index ||
        !parent ||
        parent.amountCents <= 0 ||
        parent.kind === 'service_fee' ||
        parent.kind === 'tax'
      )
        throw new Error('Discount/aid requires an earlier charge parent line');
      discountByParent.set(
        line.parentLineIndex,
        (discountByParent.get(line.parentLineIndex) ?? 0n) -
          BigInt(line.amountCents),
      );
      discount -= BigInt(line.amountCents);
    } else {
      if (line.parentLineIndex !== undefined)
        throw new Error('Only discount/aid may use parentLineIndex');
      if (line.amountCents < 0)
        throw new RangeError('Charge line must be positive');
      if (line.kind === 'service_fee') serviceFee += BigInt(line.amountCents);
      else if (line.kind === 'tax') {
        if (input.source !== 'order')
          throw new Error('Tax applies only to product orders');
        if (taxLine) throw new Error('Invoice supports one product tax rate');
        taxLine = line;
        tax += BigInt(line.amountCents);
      } else {
        if (line.kind === 'product')
          productSubtotal += BigInt(line.amountCents);
        subtotal += BigInt(line.amountCents);
      }
    }
  }
  for (const [parentIndex, totalDiscount] of discountByParent) {
    const parent = input.lines[parentIndex];
    if (!parent || totalDiscount > BigInt(parent.amountCents))
      throw new Error('Discount/aid exceeds its parent line');
  }
  if (taxLine) {
    if (
      !Number.isInteger(taxLine.taxRateBps) ||
      taxLine.taxRateBps === undefined ||
      taxLine.taxRateBps < 1 ||
      taxLine.taxRateBps > 10_000 ||
      productSubtotal === 0n
    )
      throw new Error('Product tax requires a positive rate and product');
    const productDiscount = [...discountByParent.entries()]
      .filter(([index]) => input.lines[index]?.kind === 'product')
      .reduce((sum, [, amount]) => sum + amount, 0n);
    const expectedTax = percentOf(
      cents(productSubtotal - productDiscount),
      taxLine.taxRateBps,
    );
    if (taxLine.amountCents !== expectedTax)
      throw new Error('Product tax does not match discounted product cents');
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
        refundTerms: input.refundTerms ?? null,
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
