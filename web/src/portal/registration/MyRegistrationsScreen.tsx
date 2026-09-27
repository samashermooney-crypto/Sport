import { formatMoney } from '@shared/money';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Link, PageHeader } from '../../ui/primitives';
import { PortalShell } from '../PortalShell';

import '../money/money.css';

const registrationsSchema = z.strictObject({
  registrations: z.array(
    z.strictObject({
      id: z.uuid(),
      personId: z.uuid(),
      personName: z.string(),
      programId: z.uuid(),
      programName: z.string(),
      offeringId: z.uuid(),
      offeringName: z.string(),
      status: z.string(),
      statusReason: z.string().nullable(),
      checkoutId: z.uuid().nullable(),
      invoiceId: z.uuid().nullable(),
      approvalPaymentDueAt: z.iso.datetime().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
});

const waitlistSchema = z.strictObject({
  entries: z.array(
    z.strictObject({
      id: z.uuid(),
      offeringId: z.uuid(),
      offeringName: z.string(),
      programName: z.string(),
      personId: z.uuid(),
      personName: z.string(),
      position: z.number().int().positive(),
      status: z.string(),
      checkoutId: z.uuid().nullable(),
      offeredAt: z.iso.datetime().nullable(),
      offerExpiresAt: z.iso.datetime().nullable(),
    }),
  ),
});

const refundPreviewSchema = z
  .strictObject({
    registrationId: z.uuid(),
    refundCents: z.number().int().nonnegative(),
    refundBps: z.number().int().min(0).max(10_000),
    requiresApproval: z.boolean(),
    approvalThresholdCents: z.number().int().nonnegative(),
    paidCents: z.number().int().nonnegative(),
  })
  .nullable();

const cancellationResponseSchema = z.strictObject({
  status: z.enum(['canceled', 'withdrawn']),
  refundProposal: refundPreviewSchema,
});

const waitlistActionSchema = z.strictObject({ ok: z.literal(true) });
const acceptedWaitlistSchema = z.strictObject({ checkoutId: z.uuid() });

function actionError(value: unknown, fallback: string): string {
  return value instanceof Error ? value.message : fallback;
}

export function MyRegistrationsScreen({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [cancelId, setCancelId] = useState('');
  const [cancelKey, setCancelKey] = useState('');
  const [cancelError, setCancelError] = useState('');
  const [waitlistError, setWaitlistError] = useState('');
  const [busyId, setBusyId] = useState('');
  const base = `/registration/orgs/${encodeURIComponent(orgId)}`;
  const registrations = useQuery({
    queryKey: ['registration', orgId, 'mine'],
    queryFn: () => apiGet(`${base}/me/registrations`, registrationsSchema),
  });
  const waitlist = useQuery({
    queryKey: ['registration', orgId, 'waitlist-mine'],
    queryFn: () => apiGet(`${base}/me/waitlist`, waitlistSchema),
  });
  const preview = useQuery({
    queryKey: ['registration', orgId, 'cancel-preview', cancelId],
    queryFn: () =>
      apiGet(
        `${base}/me/registrations/${encodeURIComponent(cancelId)}/cancellation-preview`,
        refundPreviewSchema,
      ),
    enabled: Boolean(cancelId),
    retry: false,
  });

  const openCancellation = (registrationId: string): void => {
    setCancelId(registrationId);
    setCancelKey(crypto.randomUUID());
    setCancelError('');
  };

  const cancelRegistration = async (): Promise<void> => {
    if (!cancelId || !cancelKey || busyId) return;
    setBusyId(cancelId);
    setCancelError('');
    try {
      await apiPost(
        `${base}/me/registrations/${encodeURIComponent(cancelId)}/cancel`,
        { reason: 'Family requested cancellation' },
        cancellationResponseSchema,
        cancelKey,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['registration', orgId, 'mine'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['registration', orgId, 'waitlist-mine'],
        }),
      ]);
      setCancelId('');
      setCancelKey('');
    } catch (caught) {
      setCancelError(
        actionError(caught, 'Cancellation could not be completed.'),
      );
    } finally {
      setBusyId('');
    }
  };

  const acceptOffer = async (entryId: string): Promise<void> => {
    setBusyId(entryId);
    setWaitlistError('');
    try {
      const result = await apiPost(
        `${base}/me/waitlist/${encodeURIComponent(entryId)}/accept`,
        {},
        acceptedWaitlistSchema,
      );
      await queryClient.invalidateQueries({
        queryKey: ['registration', orgId, 'waitlist-mine'],
      });
      void navigate(
        `/portal/orgs/${orgId}/register/checkouts/${result.checkoutId}/requirements`,
      );
    } catch (caught) {
      setWaitlistError(
        actionError(caught, 'This waitlist offer is unavailable.'),
      );
    } finally {
      setBusyId('');
    }
  };

  const declineOffer = async (entryId: string): Promise<void> => {
    setBusyId(entryId);
    setWaitlistError('');
    try {
      await apiPost(
        `${base}/me/waitlist/${encodeURIComponent(entryId)}/decline`,
        {},
        waitlistActionSchema,
      );
      await queryClient.invalidateQueries({
        queryKey: ['registration', orgId, 'waitlist-mine'],
      });
    } catch (caught) {
      setWaitlistError(
        actionError(caught, 'This waitlist entry is unavailable.'),
      );
    } finally {
      setBusyId('');
    }
  };

  return (
    <PortalShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="REGISTRATION"
          title="My registrations"
          description="Review registration status, waitlist offers, and cancellation terms."
        />
        <p>
          <Link to={`/portal/orgs/${orgId}/register`}>
            Find another program
          </Link>
        </p>
        {registrations.isLoading || waitlist.isLoading ? (
          <p role="status">Loading registrations…</p>
        ) : null}
        {registrations.error || waitlist.error ? (
          <p role="alert" className="money-error">
            Registration details are unavailable. Refresh to try again.
          </p>
        ) : null}
        {registrations.data ? (
          <section
            className="money-panel"
            aria-labelledby="my-registrations-title"
          >
            <h2 id="my-registrations-title">Program registrations</h2>
            {registrations.data.registrations.length === 0 ? (
              <p>No registrations yet.</p>
            ) : null}
            <ul className="money-invoices">
              {registrations.data.registrations.map((registration) => (
                <li key={registration.id}>
                  <div className="money-invoice-heading">
                    <strong>{registration.programName}</strong>
                    <span>{registration.status.replaceAll('_', ' ')}</span>
                  </div>
                  <p>
                    {registration.personName} · {registration.offeringName}
                  </p>
                  <p>
                    <Link
                      to={`/portal/orgs/${orgId}/register?participantId=${encodeURIComponent(registration.personId)}`}
                    >
                      Register {registration.personName} again
                    </Link>
                  </p>
                  {registration.statusReason ? (
                    <p>{registration.statusReason}</p>
                  ) : null}
                  {registration.invoiceId ? (
                    <p>
                      <Link to={`/portal/orgs/${orgId}/money/invoices`}>
                        View invoices
                      </Link>
                    </p>
                  ) : null}
                  {[
                    'confirmed',
                    'pending_payment',
                    'pending_approval',
                  ].includes(registration.status) ? (
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => {
                        openCancellation(registration.id);
                      }}
                    >
                      Review cancellation
                    </button>
                  ) : null}
                  {cancelId === registration.id ? (
                    <div className="money-panel" aria-live="polite">
                      <h3>Cancellation terms</h3>
                      {preview.isFetching ? (
                        <p role="status">Calculating the current refund…</p>
                      ) : null}
                      {preview.error ? (
                        <p role="alert" className="money-error">
                          Refund terms are unavailable. Try again before
                          canceling.
                        </p>
                      ) : null}
                      {preview.data === null &&
                      !preview.isFetching &&
                      !preview.error ? (
                        <p>
                          No paid amount is refundable under this invoice
                          policy.
                        </p>
                      ) : null}
                      {preview.data ? (
                        <p>
                          Estimated refund:{' '}
                          <strong>
                            {formatMoney(
                              preview.data.refundCents,
                              i18n.language,
                            )}
                          </strong>
                          {preview.data.requiresApproval
                            ? ' — a separate finance approval is required.'
                            : ''}
                        </p>
                      ) : null}
                      {cancelError ? (
                        <p role="alert" className="money-error">
                          {cancelError}
                        </p>
                      ) : null}
                      <button
                        className="button"
                        type="button"
                        disabled={
                          busyId === registration.id ||
                          preview.isFetching ||
                          Boolean(preview.error)
                        }
                        onClick={() => void cancelRegistration()}
                      >
                        {busyId === registration.id
                          ? 'Canceling…'
                          : 'Confirm cancellation'}
                      </button>{' '}
                      <button
                        type="button"
                        disabled={busyId === registration.id}
                        onClick={() => {
                          setCancelId('');
                          setCancelKey('');
                          setCancelError('');
                        }}
                      >
                        Keep registration
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {waitlist.data ? (
          <section className="money-panel" aria-labelledby="my-waitlist-title">
            <h2 id="my-waitlist-title">Waitlists</h2>
            {waitlist.data.entries.length === 0 ? (
              <p>No active waitlist entries.</p>
            ) : null}
            <ul className="money-invoices">
              {waitlist.data.entries.map((entry) => (
                <li key={entry.id}>
                  <div className="money-invoice-heading">
                    <strong>{entry.programName}</strong>
                    <span>{entry.status.replaceAll('_', ' ')}</span>
                  </div>
                  <p>
                    {entry.personName} · {entry.offeringName} · position{' '}
                    {entry.position}
                  </p>
                  {entry.offerExpiresAt ? (
                    <p>
                      Offer expires{' '}
                      {new Date(entry.offerExpiresAt).toLocaleString(
                        i18n.language,
                      )}
                    </p>
                  ) : null}
                  {entry.status === 'offered' ? (
                    <>
                      <button
                        className="button"
                        type="button"
                        disabled={busyId === entry.id}
                        onClick={() => void acceptOffer(entry.id)}
                      >
                        {busyId === entry.id
                          ? 'Opening offer…'
                          : 'Accept offer'}
                      </button>{' '}
                      <button
                        type="button"
                        disabled={busyId === entry.id}
                        onClick={() => void declineOffer(entry.id)}
                      >
                        Decline
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {waitlistError ? (
          <p role="alert" className="money-error">
            {waitlistError}
          </p>
        ) : null}
      </main>
    </PortalShell>
  );
}
