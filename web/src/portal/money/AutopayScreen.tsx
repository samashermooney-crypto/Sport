import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';

import './money.css';

const authorizationSchema = z.strictObject({
  id: z.uuid(),
  invoiceId: z.uuid(),
  invoiceNumber: z.number().int().positive(),
  paymentMethodId: z.uuid(),
  methodType: z.string(),
  last4: z.string().nullable(),
  authorizedAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  mandateTextVersion: z.string(),
  futureInstallments: z.number().int().nonnegative(),
});
const listSchema = z.strictObject({
  authorizations: z.array(authorizationSchema),
});
const revocationSchema = z.strictObject({
  revoked: z.boolean(),
  stoppedInstallments: z.number().int().nonnegative(),
});
type Authorization = z.output<typeof authorizationSchema>;

export function AutopayScreen({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}): React.JSX.Element {
  const [authorizations, setAuthorizations] = useState<Authorization[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await apiGet(
        `/finance/orgs/${encodeURIComponent(orgId)}/me/autopay`,
        listSchema,
      );
      setAuthorizations(result.authorizations);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Autopay is unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [orgId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const revoke = async (authorization: Authorization): Promise<void> => {
    if (
      !window.confirm(
        `Stop autopay for invoice #${String(authorization.invoiceNumber)}? ` +
          'A payment already in progress may still complete.',
      )
    )
      return;
    setPendingId(authorization.id);
    setError('');
    setNotice('');
    try {
      const result = await apiPost(
        `/finance/orgs/${encodeURIComponent(orgId)}/me/autopay/${authorization.id}/revoke`,
        {},
        revocationSchema,
      );
      setNotice(
        result.revoked
          ? `Autopay stopped for ${String(result.stoppedInstallments)} future installment${result.stoppedInstallments === 1 ? '' : 's'}.`
          : 'Autopay was already stopped.',
      );
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Autopay could not be stopped.',
      );
    } finally {
      setPendingId(null);
    }
  };
  return (
    <section className="money-panel" aria-label={`${orgName} autopay`}>
      <h2>{orgName} autopay</h2>
      {loading ? <p role="status">Loading autopay…</p> : null}
      {error ? (
        <p role="alert" className="money-error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!loading && error ? (
        <button
          className="button"
          type="button"
          onClick={() => {
            void refresh();
          }}
        >
          Retry
        </button>
      ) : null}
      {!loading && !error && authorizations.length === 0 ? (
        <p>No autopay authorizations for this organization.</p>
      ) : null}
      {!loading && !error ? (
        <ul className="money-autopay-list">
          {authorizations.map((authorization) => (
            <li key={authorization.id}>
              <div>
                <strong>Invoice #{authorization.invoiceNumber}</strong>
                <span>
                  {authorization.methodType} ending{' '}
                  {authorization.last4 ?? 'unknown'}
                </span>
                <span>
                  {authorization.revokedAt
                    ? 'Autopay stopped'
                    : `${String(authorization.futureInstallments)} future installment${authorization.futureInstallments === 1 ? '' : 's'}`}
                </span>
              </div>
              {!authorization.revokedAt ? (
                <button
                  className="button"
                  type="button"
                  disabled={pendingId !== null}
                  onClick={() => {
                    void revoke(authorization);
                  }}
                >
                  Stop autopay
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
