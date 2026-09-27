import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet } from '../../api/client';

import './money.css';

const balanceSchema = z.strictObject({
  orgId: z.uuid(),
  accountBalanceCents: z.number().int().nonnegative(),
  householdBalances: z.array(
    z.strictObject({
      householdId: z.uuid(),
      householdName: z.string(),
      balanceCents: z.number().int().nonnegative(),
    }),
  ),
  totalAvailableCents: z.number().int().nonnegative(),
  asOfLocalDate: z.iso.date(),
});
type Balance = z.infer<typeof balanceSchema>;

const currency = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
});
const money = (cents: number): string => currency.format(cents / 100);

export function CreditBalanceScreen({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}): React.JSX.Element {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await apiGet(
        `/finance/orgs/${encodeURIComponent(orgId)}/me/credits`,
        balanceSchema,
      );
      if (result.orgId !== orgId)
        throw new Error('Credit organization does not match');
      setBalance(result);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Credit balance is unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [orgId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="money-panel" aria-label={`${orgName} credit balance`}>
      <h2>{orgName} credit balance</h2>
      {loading ? <p role="status">Loading credit balance…</p> : null}
      {error ? (
        <p className="money-error" role="alert">
          {error}
        </p>
      ) : null}
      {!loading && error ? (
        <button className="button" type="button" onClick={() => void refresh()}>
          Retry
        </button>
      ) : null}
      {!loading && !error && balance ? (
        <>
          <dl className="money-lines">
            <div>
              <dt>Available credit</dt>
              <dd className="money-total">
                {money(balance.totalAvailableCents)}
              </dd>
            </div>
            {balance.accountBalanceCents > 0 ? (
              <div>
                <dt>Your credit</dt>
                <dd>{money(balance.accountBalanceCents)}</dd>
              </div>
            ) : null}
            {balance.householdBalances.map((household) => (
              <div key={household.householdId}>
                <dt>{household.householdName}</dt>
                <dd>{money(household.balanceCents)}</dd>
              </div>
            ))}
          </dl>
          {balance.totalAvailableCents === 0 ? (
            <p>No available credit.</p>
          ) : null}
          <p>As of {balance.asOfLocalDate}</p>
        </>
      ) : null}
    </section>
  );
}
