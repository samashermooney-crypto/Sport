import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet } from '../../api/client';

import './money.css';

const statementSchema = z.strictObject({
  orgId: z.uuid(),
  orgName: z.string(),
  year: z.number().int(),
  timezone: z.string(),
  currency: z.literal('USD'),
  paymentCount: z.number().int().nonnegative(),
  totalPaidCents: z.number().int().nonnegative(),
  refundedToOriginalCents: z.number().int().nonnegative(),
  movedToCreditCents: z.number().int().nonnegative(),
  donationPaidCents: z.number().int().nonnegative(),
  donationRefundedCents: z.number().int().nonnegative(),
});
type Statement = z.output<typeof statementSchema>;
const currency = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
});
const money = (cents: number): string => currency.format(cents / 100);

export function YearEndStatementScreen({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}): React.JSX.Element {
  const [yearInput, setYearInput] = useState(String(new Date().getFullYear()));
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(
    async (year: number): Promise<void> => {
      setLoading(true);
      setError('');
      try {
        const result = await apiGet(
          `/finance/orgs/${encodeURIComponent(orgId)}/me/statements/${String(year)}`,
          statementSchema,
        );
        if (result.orgId !== orgId || result.year !== year)
          throw new Error('Statement scope does not match');
        setStatement(result);
      } catch (caught) {
        setStatement(null);
        setError(
          caught instanceof Error
            ? caught.message
            : 'Statement is unavailable.',
        );
      } finally {
        setLoading(false);
      }
    },
    [orgId],
  );
  useEffect(() => {
    void load(new Date().getFullYear());
  }, [load]);
  const showYear = (): void => {
    const year = Number(yearInput);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      setError('Enter a year from 2000 to 2100.');
      return;
    }
    void load(year);
  };
  return (
    <section
      className="money-panel"
      aria-label={`${orgName} year-end statement`}
    >
      <h2>{orgName} year-end statement</h2>
      <div className="money-statement-year">
        <label htmlFor="statement-year">Calendar year</label>
        <input
          id="statement-year"
          type="number"
          inputMode="numeric"
          min="2000"
          max="2100"
          value={yearInput}
          onChange={(event) => {
            setYearInput(event.target.value);
          }}
        />
        <button
          className="button"
          type="button"
          onClick={showYear}
          disabled={loading}
        >
          Show statement
        </button>
      </div>
      {loading ? <p role="status">Loading statement…</p> : null}
      {error ? (
        <p role="alert" className="money-error">
          {error}
        </p>
      ) : null}
      {!loading && statement ? (
        <>
          <p>
            {statement.paymentCount} payments recorded in {statement.year} (
            {statement.timezone}).
          </p>
          <dl className="money-lines">
            <div>
              <dt>Payments received</dt>
              <dd>{money(statement.totalPaidCents)}</dd>
            </div>
            <div>
              <dt>Refunded to original method</dt>
              <dd>{money(statement.refundedToOriginalCents)}</dd>
            </div>
            <div>
              <dt>Moved to account credit</dt>
              <dd>{money(statement.movedToCreditCents)}</dd>
            </div>
            <div>
              <dt>Donation payments</dt>
              <dd>{money(statement.donationPaidCents)}</dd>
            </div>
            <div>
              <dt>Donation refunds</dt>
              <dd>{money(statement.donationRefundedCents)}</dd>
            </div>
          </dl>
        </>
      ) : null}
    </section>
  );
}
