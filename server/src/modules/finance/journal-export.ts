import type { PayoutReconciliation } from './reconciliation.js';

export interface JournalAccounts {
  bank: string;
  stripeClearing: string;
  processingFees: string;
  transactionTypes: Readonly<Record<string, string>>;
}

export interface JournalExportOptions {
  name?: string;
  className?: string;
}

export interface JournalLine {
  date: string;
  journalNo: string;
  account: string;
  debitCents: number;
  creditCents: number;
  description: string;
  name: string;
  className: string;
}

export class JournalExportError extends Error {}

function validAccount(code: string | undefined): code is string {
  return Boolean(code && code.trim() && !/[\r\n]/.test(code));
}

function addSigned(
  lines: JournalLine[],
  base: Omit<JournalLine, 'account' | 'debitCents' | 'creditCents'>,
  account: string,
  signedCents: number,
): void {
  if (signedCents === 0) return;
  if (!Number.isSafeInteger(signedCents))
    throw new JournalExportError('Journal amount exceeds safe integer cents');
  lines.push({
    ...base,
    account,
    debitCents: Math.max(signedCents, 0),
    creditCents: Math.max(-signedCents, 0),
  });
}

/** A paid payout is one balanced journal; each Stripe movement keeps its own GL code. */
export function payoutJournalLines(
  report: PayoutReconciliation,
  accounts: JournalAccounts,
  options: JournalExportOptions = {},
): JournalLine[] {
  if (
    report.status !== 'paid' ||
    !report.arrivalDate ||
    !report.complete ||
    report.differenceCents !== 0 ||
    report.unlinkedSourceCount !== 0
  )
    throw new JournalExportError('Payout must be paid and fully reconciled');
  if (
    !/^po_[A-Za-z0-9_]+$/.test(report.payoutId) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(report.arrivalDate)
  )
    throw new JournalExportError('Payout identity or arrival date is invalid');
  if (
    ![accounts.bank, accounts.stripeClearing, accounts.processingFees].every(
      validAccount,
    )
  )
    throw new JournalExportError(
      'Bank, clearing and fee GL codes are required',
    );
  const lines: JournalLine[] = [];
  const common = {
    date: report.arrivalDate,
    journalNo: `PAYOUT-${report.payoutId}`,
    name: options.name ?? '',
    className: options.className ?? '',
  };
  let transactionNetCents = 0;
  const seen = new Set<string>();
  for (const row of report.rows) {
    if (seen.has(row.transactionId))
      throw new JournalExportError('Duplicate payout transaction');
    seen.add(row.transactionId);
    const typeAccount = accounts.transactionTypes[row.type];
    if (!validAccount(typeAccount))
      throw new JournalExportError(`GL code is required for ${row.type}`);
    if (
      ![row.amountCents, row.feeCents, row.netCents].every(
        Number.isSafeInteger,
      ) ||
      row.amountCents - row.feeCents !== row.netCents
    )
      throw new JournalExportError('Stripe transaction cents do not reconcile');
    const description = [
      row.type,
      row.transactionId,
      row.invoiceNumbers.length
        ? `Invoice ${row.invoiceNumbers.join(';')}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const base = { ...common, description };
    addSigned(lines, base, accounts.stripeClearing, row.netCents);
    addSigned(lines, base, accounts.processingFees, row.feeCents);
    addSigned(lines, base, typeAccount, -row.amountCents);
    transactionNetCents += row.netCents;
    if (!Number.isSafeInteger(transactionNetCents))
      throw new JournalExportError('Payout exceeds safe integer cents');
  }
  if (
    transactionNetCents !== report.amountCents ||
    transactionNetCents !== report.transactionNetCents
  )
    throw new JournalExportError('Payout amount differs from transactions');
  const payoutBase = {
    ...common,
    description: `Stripe payout ${report.payoutId}`,
  };
  addSigned(lines, payoutBase, accounts.bank, report.amountCents);
  addSigned(lines, payoutBase, accounts.stripeClearing, -report.amountCents);
  const debitCents = lines.reduce((sum, line) => sum + line.debitCents, 0);
  const creditCents = lines.reduce((sum, line) => sum + line.creditCents, 0);
  if (!Number.isSafeInteger(debitCents) || debitCents !== creditCents)
    throw new JournalExportError('Journal is out of balance');
  return lines;
}

function csvCell(value: string): string {
  const escaped = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(escaped)
    ? `"${escaped.replaceAll('"', '""')}"`
    : escaped;
}

function dollars(cents: number): string {
  return cents ? (cents / 100).toFixed(2) : '';
}

/** QuickBooks Online journal import columns; amounts are decimal dollars. */
export function payoutJournalCsv(lines: readonly JournalLine[]): string {
  const header =
    'Date,Journal No,Account,Debits,Credits,Description,Name,Class';
  const rows = lines.map((line) =>
    [
      line.date,
      line.journalNo,
      line.account,
      dollars(line.debitCents),
      dollars(line.creditCents),
      line.description,
      line.name,
      line.className,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header, ...rows].join('\r\n') + '\r\n';
}
