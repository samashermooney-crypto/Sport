import { formatMoney } from '@shared/money';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';

import './money.css';

const scheduleSchema = z.strictObject({
  installments: z.array(
    z.strictObject({
      id: z.uuid(),
      sequence: z.number().int().positive(),
      dueOn: z.iso.date(),
      amountCents: z.number().int().positive(),
      paidCents: z.number().int().nonnegative(),
      status: z.enum([
        'scheduled',
        'processing',
        'paid',
        'failed',
        'canceled',
        'waived',
      ]),
      autopay: z.boolean(),
      version: z.number().int().positive(),
    }),
  ),
  consents: z.array(
    z.strictObject({
      id: z.uuid(),
      paymentMethodId: z.uuid(),
      type: z.string(),
      last4: z.string().nullable(),
    }),
  ),
});
const resultSchema = z.strictObject({
  installmentId: z.uuid(),
  version: z.number().int().positive(),
  dueOn: z.iso.date(),
  amountCents: z.number().int().positive(),
  addedInstallmentId: z.uuid().nullable(),
  addedAmountCents: z.number().int().positive().nullable(),
  paymentMethodId: z.uuid().nullable().optional(),
  consentMandateId: z.uuid().nullable().optional(),
  waivedCents: z.number().int().positive().nullable().optional(),
});
type Schedule = z.output<typeof scheduleSchema>;
type Action = 'change_due_date' | 'split' | 'waive' | 'switch_payment_method';

export function InstallmentStaffScreen({
  orgId,
  invoiceId,
}: {
  orgId: string;
  invoiceId: string;
}): React.JSX.Element {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [installmentId, setInstallmentId] = useState('');
  const [action, setAction] = useState<Action>('change_due_date');
  const [dueOn, setDueOn] = useState('');
  const [splitCents, setSplitCents] = useState('');
  const [consentId, setConsentId] = useState('');
  const [reason, setReason] = useState('');
  const actionKey = useRef<string | null>(null);
  const resetKey = (): void => {
    actionKey.current = null;
  };
  const base = `/finance/orgs/${encodeURIComponent(orgId)}`;
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await apiGet(
        `${base}/invoices/${encodeURIComponent(invoiceId)}/installments`,
        scheduleSchema,
      );
      setSchedule(result);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Installments are unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [base, invoiceId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const selected = schedule?.installments.find(
    (item) => item.id === installmentId,
  );
  const submit = async (
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    actionKey.current ??= crypto.randomUUID();
    const common = { action, expectedVersion: selected.version, reason };
    let body: unknown;
    if (action === 'change_due_date') body = { ...common, newDueOn: dueOn };
    else if (action === 'split')
      body = { ...common, newDueOn: dueOn, splitCents: Number(splitCents) };
    else if (action === 'waive') body = common;
    else {
      const consent = schedule?.consents.find((item) => item.id === consentId);
      if (!consent) {
        setError('Choose payer consent for this invoice.');
        setBusy(false);
        return;
      }
      body = {
        ...common,
        paymentMethodId: consent.paymentMethodId,
        consentMandateId: consent.id,
      };
    }
    try {
      await apiPost(
        `${base}/installments/${selected.id}/actions`,
        body,
        resultSchema,
        actionKey.current,
      );
      resetKey();
      setNotice('Installment action recorded.');
      setReason('');
      setDueOn('');
      setSplitCents('');
      setConsentId('');
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Action could not be recorded.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="money-panel" aria-label="Invoice installments">
      <h2>Invoice installments</h2>
      {loading ? <p role="status">Loading installments…</p> : null}
      {error ? (
        <p role="alert" className="money-error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!loading && !schedule && error ? (
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
      {schedule?.installments.length === 0 ? (
        <p>No installment plan for this invoice.</p>
      ) : null}
      {schedule && schedule.installments.length > 0 ? (
        <>
          <ul className="money-installments">
            {schedule.installments.map((item) => (
              <li key={item.id}>
                <strong>
                  #{item.sequence} — {item.dueOn}
                </strong>{' '}
                {formatMoney(item.amountCents, 'en-US')}; paid{' '}
                {formatMoney(item.paidCents, 'en-US')}; {item.status}
              </li>
            ))}
          </ul>
          <form
            className="money-staff-action"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <label htmlFor="staff-installment">Installment</label>
            <select
              id="staff-installment"
              value={installmentId}
              onChange={(event) => {
                setInstallmentId(event.target.value);
                resetKey();
              }}
              required
            >
              <option value="">Choose an outstanding installment</option>
              {schedule.installments
                .filter((item) => ['scheduled', 'failed'].includes(item.status))
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    #{item.sequence} — {item.dueOn} —{' '}
                    {formatMoney(item.amountCents - item.paidCents, 'en-US')}
                  </option>
                ))}
            </select>
            <label htmlFor="staff-action">Action</label>
            <select
              id="staff-action"
              value={action}
              onChange={(event) => {
                setAction(event.target.value as Action);
                resetKey();
              }}
            >
              <option value="change_due_date">Change due date</option>
              <option value="split">Split installment</option>
              <option value="waive">Waive unpaid amount</option>
              <option value="switch_payment_method">
                Use payer-authorized method
              </option>
            </select>
            {action === 'change_due_date' || action === 'split' ? (
              <>
                <label htmlFor="staff-new-date">New due date</label>
                <input
                  id="staff-new-date"
                  type="date"
                  value={dueOn}
                  required
                  onChange={(event) => {
                    setDueOn(event.target.value);
                    resetKey();
                  }}
                />
              </>
            ) : null}
            {action === 'split' ? (
              <>
                <label htmlFor="staff-split-cents">
                  Amount moved to new installment (cents)
                </label>
                <input
                  id="staff-split-cents"
                  type="number"
                  min="1"
                  step="1"
                  value={splitCents}
                  required
                  onChange={(event) => {
                    setSplitCents(event.target.value);
                    resetKey();
                  }}
                />
              </>
            ) : null}
            {action === 'switch_payment_method' ? (
              <>
                <label htmlFor="staff-consent">Payer consent</label>
                <select
                  id="staff-consent"
                  value={consentId}
                  required
                  onChange={(event) => {
                    setConsentId(event.target.value);
                    resetKey();
                  }}
                >
                  <option value="">Choose an active authorization</option>
                  {schedule.consents.map((consent) => (
                    <option key={consent.id} value={consent.id}>
                      {consent.type} ending {consent.last4 ?? 'unknown'}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            <label htmlFor="staff-reason">Reason</label>
            <textarea
              id="staff-reason"
              minLength={5}
              maxLength={500}
              required
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                resetKey();
              }}
            />
            <button
              className="button"
              type="submit"
              disabled={busy || !selected}
            >
              {busy ? 'Recording…' : 'Record action'}
            </button>
          </form>
        </>
      ) : null}
    </section>
  );
}
