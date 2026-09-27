import { describe, expect, it } from 'vitest';

import {
  JournalExportError,
  payoutJournalCsv,
  payoutJournalLines,
  type JournalAccounts,
} from './journal-export.js';
import type { PayoutReconciliation } from './reconciliation.js';

const accounts: JournalAccounts = {
  bank: '1000',
  stripeClearing: '1010',
  processingFees: '6200',
  transactionTypes: { charge: '4000', refund: '4010' },
};
const report: PayoutReconciliation = {
  payoutId: 'po_journal',
  status: 'paid',
  arrivalDate: '2026-09-27',
  amountCents: 770,
  transactionNetCents: 770,
  differenceCents: 0,
  complete: true,
  unlinkedSourceCount: 0,
  rows: [
    {
      transactionId: 'txn_charge',
      type: 'charge',
      amountCents: 1000,
      feeCents: 30,
      netCents: 970,
      sourceId: 'ch_1',
      paymentId: 'payment-1',
      invoiceNumbers: [42],
    },
    {
      transactionId: 'txn_refund',
      type: 'refund',
      amountCents: -200,
      feeCents: 0,
      netCents: -200,
      sourceId: 're_1',
      paymentId: 'payment-1',
      invoiceNumbers: [42],
    },
  ],
};

describe('payout journal export', () => {
  it('balances gross charges, fees, refunds, clearing and the bank payout', () => {
    const lines = payoutJournalLines(report, accounts, {
      name: '=Untrusted',
      className: 'Youth Club',
    });
    expect(lines.reduce((sum, line) => sum + line.debitCents, 0)).toBe(1970);
    expect(lines.reduce((sum, line) => sum + line.creditCents, 0)).toBe(1970);
    expect(lines).toContainEqual(
      expect.objectContaining({
        account: '1000',
        debitCents: 770,
        creditCents: 0,
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        account: '6200',
        debitCents: 30,
        creditCents: 0,
      }),
    );
    const csv = payoutJournalCsv(lines);
    expect(csv).toContain(
      'Date,Journal No,Account,Debits,Credits,Description,Name,Class',
    );
    expect(csv).toContain("'=Untrusted");
    expect(csv).toContain('7.70');
  });

  it('refuses incomplete, inconsistent or unmapped payout movements', () => {
    const charge = report.rows[0];
    const refund = report.rows[1];
    if (!charge || !refund) throw new Error('Journal fixture is incomplete');
    expect(() =>
      payoutJournalLines({ ...report, complete: false }, accounts),
    ).toThrow(JournalExportError);
    expect(() =>
      payoutJournalLines({ ...report, unlinkedSourceCount: 1 }, accounts),
    ).toThrow(JournalExportError);
    expect(() =>
      payoutJournalLines(report, {
        ...accounts,
        transactionTypes: { charge: '4000' },
      }),
    ).toThrow('GL code is required for refund');
    expect(() =>
      payoutJournalLines(
        { ...report, rows: [{ ...charge, netCents: 971 }, refund] },
        accounts,
      ),
    ).toThrow('Stripe transaction cents do not reconcile');
  });
});
