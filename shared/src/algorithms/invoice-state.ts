export type InvoiceStatus =
  'void' | 'paid' | 'partially_paid' | 'past_due' | 'open';
export type InvoiceStateInput = {
  totalCents: number;
  succeededAllocationsCents: number;
  refundedToMethodCents: number;
  disputedLostCents?: number;
  creditAppliedCents: number;
  disputedCents?: number;
  installments?: readonly {
    dueOn: string;
    amountCents: number;
    paidCents: number;
  }[];
  dueOn?: string | null;
  todayLocal: string;
  confirmed: boolean;
  voided: boolean;
};
export type InvoiceState = {
  status: InvoiceStatus;
  balanceCents: number;
  paidNetCents: number;
  disputedCents: number;
  disputedLostCents: number;
};

function amount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be non-negative integer cents`);
}

export function deriveInvoiceState(input: InvoiceStateInput): InvoiceState {
  amount(input.totalCents, 'total');
  amount(input.succeededAllocationsCents, 'succeeded allocations');
  amount(input.refundedToMethodCents, 'refunds');
  amount(input.creditAppliedCents, 'credit');
  amount(input.disputedCents ?? 0, 'disputed amount');
  amount(input.disputedLostCents ?? 0, 'lost dispute amount');
  if (
    input.refundedToMethodCents +
      (input.disputedLostCents ?? 0) +
      (input.disputedCents ?? 0) >
    input.succeededAllocationsCents
  )
    throw new RangeError('Refunds and disputes exceed succeeded allocations');
  const paidNetCents =
    input.succeededAllocationsCents -
    input.refundedToMethodCents -
    (input.disputedLostCents ?? 0);
  const balanceCents =
    input.totalCents - paidNetCents - input.creditAppliedCents;
  if (balanceCents < 0 || balanceCents > input.totalCents)
    throw new RangeError('Invoice balance is outside allowed range');
  if (input.voided && (paidNetCents !== 0 || input.creditAppliedCents !== 0))
    throw new RangeError(
      'Cannot void an invoice with payments or credits applied',
    );
  for (const installment of input.installments ?? []) {
    amount(installment.amountCents, 'installment amount');
    amount(installment.paidCents, 'installment paid');
    if (installment.paidCents > installment.amountCents)
      throw new RangeError('Installment overpaid');
  }
  let status: InvoiceStatus;
  if (input.voided) status = 'void';
  else if (balanceCents === 0 && (input.totalCents > 0 || input.confirmed))
    status = 'paid';
  else if (
    balanceCents > 0 &&
    ((input.dueOn !== undefined &&
      input.dueOn !== null &&
      input.dueOn < input.todayLocal) ||
      (input.installments ?? []).some(
        (installment) =>
          installment.dueOn < input.todayLocal &&
          installment.paidCents < installment.amountCents,
      ))
  )
    status = 'past_due';
  else if (paidNetCents + input.creditAppliedCents > 0 && balanceCents > 0)
    status = 'partially_paid';
  else status = 'open';
  return {
    status,
    balanceCents,
    paidNetCents,
    disputedCents: input.disputedCents ?? 0,
    disputedLostCents: input.disputedLostCents ?? 0,
  };
}

export function assertInvoiceLines(
  totalCents: number,
  lines: readonly { amountCents: number }[],
): void {
  amount(totalCents, 'invoice total');
  if (lines.some((line) => !Number.isSafeInteger(line.amountCents)))
    throw new RangeError('Invoice line must be integer cents');
  if (lines.reduce((sum, line) => sum + line.amountCents, 0) !== totalCents)
    throw new RangeError('Invoice lines do not reconcile');
}

export function assertPaymentAllocations(
  paymentCents: number,
  allocationsCents: readonly number[],
  refundsCents: readonly number[],
): void {
  amount(paymentCents, 'payment');
  allocationsCents.forEach((value) => {
    amount(value, 'allocation');
  });
  refundsCents.forEach((value) => {
    amount(value, 'refund');
  });
  if (allocationsCents.reduce((sum, value) => sum + value, 0) !== paymentCents)
    throw new RangeError('Payment allocations do not reconcile');
  if (refundsCents.reduce((sum, value) => sum + value, 0) > paymentCents)
    throw new RangeError('Refunds exceed payment');
}
