import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiDelete, apiGet, apiPost } from '../../api/client';

import { assertTestPublishableKey } from './PaymentElementCheckout';
import { SetupMethodElement } from './SetupMethodElement';

import './money.css';

const methodSchema = z.strictObject({
  id: z.string().startsWith('pm_'),
  type: z.enum(['card', 'us_bank_account', 'link']),
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  expMonth: z.number().int().nullable(),
  expYear: z.number().int().nullable(),
  bankName: z.string().nullable(),
});
const methodsSchema = z.strictObject({
  methods: z.array(methodSchema),
  defaultMethodId: z.string().startsWith('pm_').nullable(),
});
const setupSchema = z.strictObject({
  id: z.string().startsWith('seti_'),
  clientSecret: z.string().min(1),
});
const successSchema = z.strictObject({ success: z.literal(true) });
type Method = z.infer<typeof methodSchema>;

const setupStorageKey = 'athlentry.setup-payment-method';
function setupKey(): string {
  try {
    const existing = sessionStorage.getItem(setupStorageKey);
    if (existing && z.uuid().safeParse(existing).success) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(setupStorageKey, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function methodName(method: Method): string {
  if (method.type === 'us_bank_account')
    return `${method.bankName ?? 'Bank account'} ending ${method.last4 ?? 'unknown'}`;
  if (method.type === 'card')
    return `${method.brand ?? 'Card'} ending ${method.last4 ?? 'unknown'}`;
  return `Link ending ${method.last4 ?? 'unknown'}`;
}

export function SavedPaymentMethodsScreen({
  publishableKey,
  returnUrl,
}: {
  publishableKey: string;
  returnUrl: string;
}): React.JSX.Element {
  assertTestPublishableKey(publishableKey);
  const [methods, setMethods] = useState<Method[]>([]);
  const [defaultMethodId, setDefaultMethodId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await apiGet('/finance/me/payment-methods', methodsSchema);
      setMethods(result.methods);
      setDefaultMethodId(result.defaultMethodId);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Saved methods are unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async (): Promise<void> => {
    setBusyId('add');
    setError('');
    setNotice('');
    try {
      const setup = await apiPost(
        '/finance/me/setup-intents',
        {},
        setupSchema,
        setupKey(),
      );
      setClientSecret(setup.clientSecret);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Payment method setup is unavailable.',
      );
    } finally {
      setBusyId(null);
    }
  };
  const update = async (
    methodId: string,
    action: 'default' | 'remove',
  ): Promise<void> => {
    if (
      action === 'remove' &&
      !window.confirm(
        'Remove this payment method? Related autopay authorizations will be revoked.',
      )
    )
      return;
    setBusyId(methodId);
    setError('');
    setNotice('');
    try {
      const path = `/finance/me/payment-methods/${encodeURIComponent(methodId)}`;
      if (action === 'default')
        await apiPost(`${path}/default`, {}, successSchema);
      else await apiDelete(path, successSchema);
      setNotice(
        action === 'default'
          ? 'Default payment method updated.'
          : 'Payment method removed. Any related autopay authorization was revoked.',
      );
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Payment method could not be updated.',
      );
    } finally {
      setBusyId(null);
    }
  };
  const saved = (status: 'succeeded' | 'processing'): void => {
    setClientSecret(null);
    try {
      sessionStorage.removeItem(setupStorageKey);
    } catch {
      /* no storage */
    }
    setNotice(
      status === 'processing'
        ? 'Bank verification is processing. Refresh your methods to check its status.'
        : 'Payment method saved.',
    );
    void refresh();
  };

  return (
    <section className="money-panel" aria-label="Saved payment methods">
      <h2>Saved payment methods</h2>
      {loading ? <p role="status">Loading saved methods…</p> : null}
      {error ? (
        <p role="alert" className="money-error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!loading && !error && methods.length === 0 ? (
        <p>No saved payment methods yet.</p>
      ) : null}
      {methods.length > 0 ? (
        <ul className="money-methods">
          {methods.map((method) => (
            <li key={method.id}>
              <span>
                {methodName(method)}
                {method.id === defaultMethodId ? ' (Default)' : ''}
              </span>
              <div className="money-method-actions">
                {method.id !== defaultMethodId ? (
                  <button
                    className="button"
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void update(method.id, 'default')}
                  >
                    Make default
                  </button>
                ) : null}
                <button
                  className="button"
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void update(method.id, 'remove')}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {!clientSecret ? (
        <button
          className="button"
          type="button"
          disabled={busyId !== null}
          onClick={() => void add()}
        >
          {busyId === 'add' ? 'Preparing…' : 'Add payment method'}
        </button>
      ) : (
        <SetupMethodElement
          publishableKey={publishableKey}
          clientSecret={clientSecret}
          returnUrl={returnUrl}
          onSaved={saved}
        />
      )}
      {!loading && error ? (
        <button className="button" type="button" onClick={() => void refresh()}>
          Retry
        </button>
      ) : null}
    </section>
  );
}
