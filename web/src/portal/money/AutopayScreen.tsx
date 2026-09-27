import { useCallback, useEffect, useRef, useState } from 'react';
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
const optionsSchema = z.strictObject({
  invoices: z.array(
    z.strictObject({
      id: z.uuid(),
      number: z.number().int().positive(),
      futureInstallments: z.number().int().positive(),
    }),
  ),
});
const savedMethodsSchema = z.strictObject({
  methods: z.array(
    z.strictObject({
      id: z.string().startsWith('pm_'),
      type: z.enum(['card', 'us_bank_account', 'link']),
      brand: z.string().nullable(),
      last4: z.string().nullable(),
      expMonth: z.number().int().nullable(),
      expYear: z.number().int().nullable(),
      bankName: z.string().nullable(),
    }),
  ),
  defaultMethodId: z.string().startsWith('pm_').nullable(),
});
const consentResultSchema = z.strictObject({
  id: z.uuid(),
  paymentMethodId: z.uuid(),
});
const consentVersion = 'staff-method-consent-v1';
const consentText =
  'I authorize this organization to charge my selected saved payment method for future unpaid installments of this invoice. I may stop future automatic charges at any time. A charge already in progress may still complete.';
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
  const [eligibleInvoices, setEligibleInvoices] = useState<
    z.output<typeof optionsSchema>['invoices']
  >([]);
  const [savedMethods, setSavedMethods] = useState<
    z.output<typeof savedMethodsSchema>['methods']
  >([]);
  const [invoiceId, setInvoiceId] = useState('');
  const [methodId, setMethodId] = useState('');
  const [accepted, setAccepted] = useState(false);
  const consentKey = useRef<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const base = `/finance/orgs/${encodeURIComponent(orgId)}/me/autopay`;
      const [result, options, methods] = await Promise.all([
        apiGet(base, listSchema),
        apiGet(`${base}/staff-method-options`, optionsSchema),
        apiGet('/finance/me/payment-methods', savedMethodsSchema),
      ]);
      setAuthorizations(result.authorizations);
      setEligibleInvoices(options.invoices);
      setSavedMethods(methods.methods);
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
  const authorize = async (): Promise<void> => {
    if (!accepted || !invoiceId || !methodId) return;
    setPendingId('consent');
    setError('');
    setNotice('');
    consentKey.current ??= crypto.randomUUID();
    try {
      await apiPost(
        `/finance/orgs/${encodeURIComponent(orgId)}/me/autopay/staff-method-consents`,
        {
          invoiceId,
          stripePaymentMethodId: methodId,
          consentVersion,
          accepted: true,
        },
        consentResultSchema,
        consentKey.current,
      );
      consentKey.current = null;
      setAccepted(false);
      setNotice(
        'Consent recorded. Finance staff may use this method for unpaid installments on the selected invoice.',
      );
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Consent could not be recorded.',
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
      {!loading && eligibleInvoices.length > 0 && savedMethods.length > 0 ? (
        <div className="money-consent">
          <h3>Authorize a saved method for staff assistance</h3>
          <p>
            This records your permission. Staff must choose the method for an
            installment before any new automatic charge.
          </p>
          <label htmlFor="autopay-invoice">Invoice</label>
          <select
            id="autopay-invoice"
            value={invoiceId}
            onChange={(event) => {
              setInvoiceId(event.target.value);
              setAccepted(false);
              consentKey.current = null;
            }}
          >
            <option value="">Choose an invoice</option>
            {eligibleInvoices.map((invoice) => (
              <option value={invoice.id} key={invoice.id}>
                Invoice #{invoice.number} ({invoice.futureInstallments} unpaid
                installments)
              </option>
            ))}
          </select>
          <label htmlFor="autopay-method">Saved payment method</label>
          <select
            id="autopay-method"
            value={methodId}
            onChange={(event) => {
              setMethodId(event.target.value);
              setAccepted(false);
              consentKey.current = null;
            }}
          >
            <option value="">Choose a saved method</option>
            {savedMethods.map((method) => (
              <option value={method.id} key={method.id}>
                {method.type} ending {method.last4 ?? 'unknown'}
              </option>
            ))}
          </select>
          <label className="money-consent-accept">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => {
                setAccepted(event.target.checked);
              }}
            />
            <span>{consentText}</span>
          </label>
          <button
            className="button"
            type="button"
            disabled={
              pendingId !== null || !accepted || !invoiceId || !methodId
            }
            onClick={() => {
              void authorize();
            }}
          >
            {pendingId === 'consent'
              ? 'Recording consent…'
              : 'Record authorization'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
