import { formatMoney } from '@shared/money';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';

import '../money/money.css';

const registrationsSchema = z.strictObject({
  registrations: z.array(
    z.strictObject({
      id: z.uuid(),
      personId: z.uuid(),
      personName: z.string(),
      householdId: z.uuid(),
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
const teamEntriesSchema = z.strictObject({
  entries: z.array(
    z.strictObject({
      id: z.uuid(),
      teamName: z.string(),
      programId: z.uuid(),
      programName: z.string(),
      divisionId: z.uuid(),
      divisionName: z.string(),
      offeringId: z.uuid(),
      offeringName: z.string(),
      captainPersonId: z.uuid().nullable(),
      status: z.string(),
      seedHint: z.number().int().nullable(),
      createdAt: z.iso.datetime(),
      inviteCount: z.number().int().nonnegative(),
    }),
  ),
});
const teamDecisionSchema = z.strictObject({
  status: z.enum(['accepted', 'declined']),
});
const teamEntryInvitesSchema = z.strictObject({
  invites: z.array(
    z.strictObject({
      id: z.uuid(),
      email: z.email(),
      status: z.enum(['pending', 'accepted', 'expired', 'canceled']),
      expiresAt: z.iso.datetime(),
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

const cancelResultSchema = z.strictObject({
  status: z.enum(['canceled', 'withdrawn']),
  refundProposal: refundPreviewSchema,
});
const approvalResultSchema = z.strictObject({
  status: z.string(),
  paymentDueAt: z.iso.datetime().nullable(),
});
const transferResultSchema = z.strictObject({
  toRegistrationId: z.uuid(),
  differenceCents: z.number().int(),
  refund: z
    .strictObject({
      refundId: z.string().startsWith('re_'),
      refundIds: z.array(z.string().startsWith('re_')).min(1).optional(),
      status: z.string().min(1),
      amountCents: z.number().int().positive(),
    })
    .optional(),
});
const waitlistOfferSchema = z.union([
  z.strictObject({ entryId: z.uuid(), expiresAt: z.iso.datetime() }),
  z.literal('full'),
  z.literal('empty'),
]);
const registrationReportSchema = z.strictObject({
  filters: z.record(z.string(), z.unknown()),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  registrations: z.array(
    z.strictObject({
      registrationId: z.uuid(),
      participantName: z.string(),
      programId: z.uuid(),
      programName: z.string(),
      divisionId: z.uuid().nullable(),
      divisionName: z.string().nullable(),
      offeringId: z.uuid(),
      offeringName: z.string(),
      teamName: z.string().nullable(),
      status: z.string(),
      registeredAt: z.iso.datetime(),
    }),
  ),
});
const uniformSizeReportSchema = z.strictObject({
  filters: z.record(z.string(), z.unknown()),
  items: z.array(
    z.strictObject({
      programId: z.uuid(),
      programName: z.string(),
      divisionId: z.uuid().nullable(),
      divisionName: z.string().nullable(),
      teamName: z.string().nullable(),
      addOnKey: z.string(),
      addOnName: z.string(),
      size: z.string().nullable(),
      quantity: z.number().int().nonnegative(),
      registrations: z.number().int().nonnegative(),
    }),
  ),
});

const statuses = [
  'pending_approval',
  'pending_payment',
  'confirmed',
  'waitlisted',
  'offered',
  'canceled',
  'withdrawn',
  'transferred_out',
] as const;

export function RegistrationStaffScreen({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('pending_approval');
  const [reportStatus, setReportStatus] = useState('');
  const [showReports, setShowReports] = useState(false);
  const [note, setNote] = useState('');
  const [teamDecisionNotes, setTeamDecisionNotes] = useState<
    Record<string, string>
  >({});
  const [viewingTeamInvites, setViewingTeamInvites] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelId, setCancelId] = useState('');
  const [transferIds, setTransferIds] = useState<Record<string, string>>({});
  const [treatment, setTreatment] = useState('carry_payment');
  const [offeringId, setOfferingId] = useState('');
  const [loadedOfferingId, setLoadedOfferingId] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const keys = useRef(new Map<string, string>());
  const base = `/registration/orgs/${encodeURIComponent(orgId)}`;
  const registrations = useQuery({
    queryKey: ['registration', orgId, 'staff', status],
    queryFn: () =>
      apiGet(
        `${base}/registrations${status ? `?status=${encodeURIComponent(status)}` : ''}`,
        registrationsSchema,
      ),
  });
  const teamEntries = useQuery({
    queryKey: ['registration', orgId, 'staff-team-entries'],
    queryFn: () => apiGet(`${base}/team-entries`, teamEntriesSchema),
  });
  const teamEntryInvites = useQuery({
    queryKey: [
      'registration',
      orgId,
      'staff-team-entry-invites',
      viewingTeamInvites,
    ],
    queryFn: () =>
      apiGet(
        `${base}/team-entries/${encodeURIComponent(viewingTeamInvites)}/invites`,
        teamEntryInvitesSchema,
      ),
    enabled: Boolean(viewingTeamInvites),
  });
  const waitlist = useQuery({
    queryKey: ['registration', orgId, 'staff-waitlist', loadedOfferingId],
    queryFn: () =>
      apiGet(
        `${base}/waitlist?offeringId=${encodeURIComponent(loadedOfferingId)}`,
        waitlistSchema,
      ),
    enabled: Boolean(loadedOfferingId),
  });
  const cancelPreview = useQuery({
    queryKey: ['registration', orgId, 'staff-cancel-preview', cancelId],
    queryFn: () =>
      apiGet(
        `${base}/registrations/${encodeURIComponent(cancelId)}/cancellation-preview`,
        refundPreviewSchema,
      ),
    enabled: Boolean(cancelId),
    retry: false,
  });
  const reportQuery = reportStatus
    ? `?status=${encodeURIComponent(reportStatus)}`
    : '';
  const registrationsReport = useQuery({
    queryKey: ['registration', orgId, 'report', reportStatus],
    queryFn: () =>
      apiGet(
        `${base}/reports/registrations${reportQuery}`,
        registrationReportSchema,
      ),
    enabled: showReports,
  });
  const uniformReport = useQuery({
    queryKey: ['registration', orgId, 'uniform-report', reportStatus],
    queryFn: () =>
      apiGet(
        `${base}/reports/uniform-sizes${reportQuery}`,
        uniformSizeReportSchema,
      ),
    enabled: showReports,
  });
  const keyFor = (action: string, id: string): string => {
    const composite = `${action}:${id}`;
    const key = keys.current.get(composite) ?? crypto.randomUUID();
    keys.current.set(composite, key);
    return key;
  };
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['registration', orgId, 'staff'],
      }),
      queryClient.invalidateQueries({
        queryKey: ['registration', orgId, 'staff-waitlist'],
      }),
      queryClient.invalidateQueries({
        queryKey: ['registration', orgId, 'staff-team-entries'],
      }),
    ]);
  };
  const decideTeamEntry = async (
    entryId: string,
    decision: 'approved' | 'declined',
    reason: string,
  ): Promise<void> => {
    if (decision === 'declined' && !reason.trim()) {
      setActionError('Add a reason before declining this team entry.');
      return;
    }
    setBusy(entryId);
    setActionError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/team-entries/${encodeURIComponent(entryId)}/approval`,
        { decision, ...(reason.trim() ? { note: reason.trim() } : {}) },
        teamDecisionSchema,
      );
      setNotice(
        decision === 'approved'
          ? 'Team entry approved.'
          : 'Team entry declined.',
      );
      await refresh();
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : 'The team entry decision could not be saved.',
      );
    } finally {
      setBusy('');
    }
  };
  const decide = async (
    registrationId: string,
    decision: 'approved' | 'declined',
  ): Promise<void> => {
    if (decision === 'declined' && !note.trim()) {
      setActionError('Add a reason before declining this registration.');
      return;
    }
    setBusy(registrationId);
    setActionError('');
    setNotice('');
    const key = keyFor(`approval:${decision}`, registrationId);
    try {
      await apiPost(
        `${base}/registrations/${encodeURIComponent(registrationId)}/approval`,
        { decision, ...(note.trim() ? { note: note.trim() } : {}) },
        approvalResultSchema,
        key,
      );
      keys.current.delete(`approval:${decision}:${registrationId}`);
      setNote('');
      setNotice(
        decision === 'approved'
          ? 'Registration approved.'
          : 'Registration declined.',
      );
      await refresh();
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : 'The decision could not be saved.',
      );
    } finally {
      setBusy('');
    }
  };
  const cancel = async (): Promise<void> => {
    if (!cancelId || !cancelReason.trim()) {
      setActionError('Enter a cancellation reason.');
      return;
    }
    setBusy(cancelId);
    setActionError('');
    const key = keyFor('cancel', cancelId);
    try {
      await apiPost(
        `${base}/registrations/${encodeURIComponent(cancelId)}/cancel`,
        { reason: cancelReason.trim() },
        cancelResultSchema,
        key,
      );
      keys.current.delete(`cancel:${cancelId}`);
      setCancelId('');
      setCancelReason('');
      setNotice(
        'Registration canceled. Any refund proposal remains subject to finance controls.',
      );
      await refresh();
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : 'Cancellation could not be completed.',
      );
    } finally {
      setBusy('');
    }
  };
  const transfer = async (registrationId: string): Promise<void> => {
    const toOfferingId = transferIds[registrationId]?.trim();
    if (!toOfferingId || !z.uuid().safeParse(toOfferingId).success) {
      setActionError('Enter a valid destination offering ID.');
      return;
    }
    setBusy(registrationId);
    setActionError('');
    setNotice('');
    try {
      const result = await apiPost(
        `${base}/registrations/${encodeURIComponent(registrationId)}/transfer`,
        {
          toOfferingId,
          financialTreatment: treatment,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        transferResultSchema,
        keyFor('transfer', registrationId),
      );
      keys.current.delete(`transfer:${registrationId}`);
      const refundIds = result.refund
        ? (result.refund.refundIds ?? [result.refund.refundId])
        : [];
      const refundLabel = refundIds.length === 1 ? 'Refund' : 'Refunds';
      const refundVerb = refundIds.length === 1 ? 'is' : 'are';
      setNotice(
        result.refund
          ? `Transfer recorded. ${refundLabel} ${refundIds.join(', ')} ${refundVerb} ${result.refund.status} for ${formatMoney(result.refund.amountCents, i18n.language)}.`
          : `Transfer recorded. Price difference: ${formatMoney(result.differenceCents, i18n.language)}.`,
      );
      setTransferIds((current) => ({ ...current, [registrationId]: '' }));
      await refresh();
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : 'Transfer could not be completed.',
      );
    } finally {
      setBusy('');
    }
  };
  const offer = async (entryId: string): Promise<void> => {
    setBusy(entryId);
    setActionError('');
    setNotice('');
    try {
      const result = await apiPost(
        `${base}/waitlist/offers`,
        { offeringId: loadedOfferingId, entryId },
        waitlistOfferSchema,
        keyFor('waitlist-offer', entryId),
      );
      if (typeof result === 'string') {
        setActionError(
          result === 'full'
            ? 'All capacity is reserved.'
            : 'No waiting entry is available.',
        );
      } else {
        keys.current.delete(`waitlist-offer:${entryId}`);
        setNotice(
          `Offer sent. It expires ${new Date(result.expiresAt).toLocaleString(i18n.language)}.`,
        );
        await refresh();
      }
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : 'The waitlist offer could not be sent.',
      );
    } finally {
      setBusy('');
    }
  };
  const downloadCsv = async (): Promise<void> => {
    setActionError('');
    try {
      const response = await fetch(
        `/api/v1${base}/reports/registrations.csv${reportQuery}`,
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error('Registration CSV is unavailable.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'registrations.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : 'Registration CSV is unavailable.',
      );
    }
  };

  return (
    <section className="money-panel" aria-label="Registration staff tools">
      <h2>Registration queue</h2>
      <label htmlFor="registration-status">Status</label>{' '}
      <select
        id="registration-status"
        value={status}
        onChange={(event) => {
          setStatus(event.target.value);
        }}
      >
        <option value="">All statuses</option>
        {statuses.map((value) => (
          <option key={value} value={value}>
            {value.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
      <label htmlFor="registration-note">Decision or transfer note</label>
      <input
        id="registration-note"
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
        }}
        maxLength={400}
      />
      {registrations.isLoading ? (
        <p role="status">Loading registration queue…</p>
      ) : null}
      {registrations.error ? (
        <p role="alert" className="money-error">
          Registration queue is unavailable.
        </p>
      ) : null}
      {registrations.data?.registrations.length === 0 ? (
        <p>No registrations match this status.</p>
      ) : null}
      {registrations.data?.registrations.map((registration) => (
        <article className="money-panel" key={registration.id}>
          <div className="money-invoice-heading">
            <strong>{registration.programName}</strong>
            <span>{registration.status.replaceAll('_', ' ')}</span>
          </div>
          <p>
            {registration.personName} · {registration.offeringName}
          </p>
          {registration.status === 'pending_approval' ? (
            <div>
              <button
                className="button"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void decide(registration.id, 'approved')}
              >
                Approve
              </button>{' '}
              <button
                className="button secondary"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void decide(registration.id, 'declined')}
              >
                Decline
              </button>
            </div>
          ) : null}
          {['confirmed', 'pending_payment', 'pending_approval'].includes(
            registration.status,
          ) ? (
            <div>
              {cancelId === registration.id ? (
                <div>
                  {cancelPreview.isFetching ? (
                    <p role="status">Calculating refund terms…</p>
                  ) : null}
                  {cancelPreview.error ? (
                    <p role="alert" className="money-error">
                      Refund preview is unavailable.
                    </p>
                  ) : null}
                  {cancelPreview.data ? (
                    <p>
                      Estimated refund{' '}
                      {formatMoney(
                        cancelPreview.data.refundCents,
                        i18n.language,
                      )}
                      {cancelPreview.data.requiresApproval
                        ? ' requires a separate finance approval.'
                        : ''}
                    </p>
                  ) : null}
                  {cancelPreview.data === null &&
                  !cancelPreview.isFetching &&
                  !cancelPreview.error ? (
                    <p>
                      No paid amount is refundable under this invoice policy.
                    </p>
                  ) : null}
                  <label htmlFor={`cancel-reason-${registration.id}`}>
                    Cancellation reason
                  </label>
                  <input
                    id={`cancel-reason-${registration.id}`}
                    value={cancelReason}
                    onChange={(event) => {
                      setCancelReason(event.target.value);
                    }}
                    maxLength={400}
                  />{' '}
                  <button
                    className="button"
                    type="button"
                    disabled={
                      Boolean(busy) ||
                      cancelPreview.isFetching ||
                      Boolean(cancelPreview.error)
                    }
                    onClick={() => void cancel()}
                  >
                    Confirm cancellation
                  </button>{' '}
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setCancelId('');
                    }}
                  >
                    Keep registration
                  </button>
                </div>
              ) : (
                <button
                  className="button secondary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setCancelId(registration.id);
                    setCancelReason('');
                    setActionError('');
                  }}
                >
                  Review cancellation
                </button>
              )}
            </div>
          ) : null}
          {['confirmed', 'pending_payment'].includes(registration.status) ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void transfer(registration.id);
              }}
            >
              <label htmlFor={`destination-${registration.id}`}>
                Destination offering ID
              </label>
              <input
                id={`destination-${registration.id}`}
                value={transferIds[registration.id] ?? ''}
                onChange={(event) => {
                  setTransferIds((current) => ({
                    ...current,
                    [registration.id]: event.target.value,
                  }));
                }}
              />
              <label htmlFor={`treatment-${registration.id}`}>
                Financial treatment
              </label>
              <select
                id={`treatment-${registration.id}`}
                value={treatment}
                onChange={(event) => {
                  setTreatment(event.target.value);
                }}
              >
                <option value="carry_payment">Carry existing payment</option>
                <option value="refund_difference">Refund the difference</option>
                <option value="charge_difference">
                  Invoice the difference
                </option>
                <option value="no_change">No financial change</option>
              </select>{' '}
              <button type="submit" disabled={Boolean(busy)}>
                Transfer registration
              </button>
            </form>
          ) : null}
        </article>
      ))}
      <section aria-labelledby="staff-team-entries-title">
        <h2 id="staff-team-entries-title">Team entries</h2>
        {teamEntries.isLoading ? (
          <p role="status">Loading team entries…</p>
        ) : null}
        {teamEntries.error ? (
          <p role="alert" className="money-error">
            Team entries are unavailable.
          </p>
        ) : null}
        {teamEntries.data?.entries.length === 0 ? (
          <p>No external team entries yet.</p>
        ) : null}
        {teamEntries.data?.entries.map((entry) => (
          <article className="money-panel" key={entry.id}>
            <div className="money-invoice-heading">
              <strong>{entry.teamName}</strong>
              <span>{entry.status.replaceAll('_', ' ')}</span>
            </div>
            <p>
              {entry.programName} · {entry.divisionName} · {entry.offeringName}
            </p>
            <p>{entry.inviteCount} player invitations</p>
            <button
              className="button secondary"
              type="button"
              aria-expanded={viewingTeamInvites === entry.id}
              onClick={() => {
                setViewingTeamInvites((current) =>
                  current === entry.id ? '' : entry.id,
                );
              }}
            >
              {viewingTeamInvites === entry.id
                ? 'Hide player invitations'
                : 'View player invitations'}
            </button>
            {viewingTeamInvites === entry.id ? (
              <div aria-live="polite">
                {teamEntryInvites.isFetching ? (
                  <p role="status">Loading player invitations…</p>
                ) : null}
                {teamEntryInvites.error ? (
                  <p role="alert" className="money-error">
                    Player invitations are unavailable.
                  </p>
                ) : null}
                {teamEntryInvites.data?.invites.length === 0 ? (
                  <p>No player invitations yet.</p>
                ) : null}
                {teamEntryInvites.data ? (
                  <ul className="money-invoices">
                    {teamEntryInvites.data.invites.map((invite) => (
                      <li key={invite.id}>
                        {invite.email} · {invite.status}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {entry.status === 'pending_approval' ? (
              <>
                <label htmlFor={`team-entry-decision-note-${entry.id}`}>
                  Decision note (required to decline)
                </label>
                <input
                  id={`team-entry-decision-note-${entry.id}`}
                  value={teamDecisionNotes[entry.id] ?? ''}
                  maxLength={400}
                  onChange={(event) => {
                    setTeamDecisionNotes((current) => ({
                      ...current,
                      [entry.id]: event.currentTarget.value,
                    }));
                  }}
                />{' '}
                <button
                  className="button"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    void decideTeamEntry(
                      entry.id,
                      'approved',
                      teamDecisionNotes[entry.id] ?? '',
                    );
                  }}
                >
                  Approve team
                </button>{' '}
                <button
                  className="button secondary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    void decideTeamEntry(
                      entry.id,
                      'declined',
                      teamDecisionNotes[entry.id] ?? '',
                    );
                  }}
                >
                  Decline team
                </button>
              </>
            ) : null}
          </article>
        ))}
      </section>
      <section aria-labelledby="staff-waitlist-title">
        <h2 id="staff-waitlist-title">Waitlist offers</h2>
        <label htmlFor="waitlist-offering-id">Offering ID</label>{' '}
        <input
          id="waitlist-offering-id"
          value={offeringId}
          onChange={(event) => {
            setOfferingId(event.target.value);
          }}
        />{' '}
        <button
          type="button"
          disabled={!z.uuid().safeParse(offeringId).success}
          onClick={() => {
            setLoadedOfferingId(offeringId);
          }}
        >
          Load waitlist
        </button>
        {waitlist.isFetching ? <p role="status">Loading waitlist…</p> : null}
        {waitlist.error ? (
          <p role="alert" className="money-error">
            Waitlist is unavailable.
          </p>
        ) : null}
        {waitlist.data?.entries.length === 0 ? <p>No active entries.</p> : null}
        {waitlist.data?.entries.map((entry) => (
          <article key={entry.id}>
            <p>
              {entry.position}. {entry.personName} · {entry.status}
            </p>
            {entry.status === 'waiting' ? (
              <button
                className="button"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void offer(entry.id)}
              >
                Offer this place
              </button>
            ) : null}
          </article>
        ))}
      </section>
      <section aria-labelledby="registration-reports-title">
        <h2 id="registration-reports-title">Registration reports</h2>
        <label htmlFor="registration-report-status">
          Filter by status
        </label>{' '}
        <select
          id="registration-report-status"
          value={reportStatus}
          onChange={(event) => {
            setReportStatus(event.target.value);
          }}
        >
          <option value="">All statuses</option>
          {statuses.map((value) => (
            <option key={value} value={value}>
              {value.replaceAll('_', ' ')}
            </option>
          ))}
        </select>{' '}
        <button
          className="button secondary"
          type="button"
          onClick={() => {
            setShowReports((current) => !current);
          }}
        >
          {showReports ? 'Hide reports' : 'Load reports'}
        </button>{' '}
        {showReports ? (
          <button
            className="button"
            type="button"
            onClick={() => void downloadCsv()}
          >
            Download registration CSV
          </button>
        ) : null}
        {showReports && registrationsReport.isFetching ? (
          <p role="status">Loading reports…</p>
        ) : null}
        {showReports && (registrationsReport.error || uniformReport.error) ? (
          <p role="alert" className="money-error">
            Registration reports are unavailable.
          </p>
        ) : null}
        {showReports && registrationsReport.data ? (
          <>
            <p>
              {registrationsReport.data.total} registrations
              {registrationsReport.data.truncated
                ? ' (first 10,000 shown)'
                : ''}
            </p>
            <div className="table-scroll">
              <table className="ui-table">
                <caption>
                  Registrations by program, division, offering and status
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Participant</th>
                    <th scope="col">Program</th>
                    <th scope="col">Division</th>
                    <th scope="col">Offering</th>
                    <th scope="col">Status</th>
                    <th scope="col">Registered</th>
                  </tr>
                </thead>
                <tbody>
                  {registrationsReport.data.registrations.map((row) => (
                    <tr key={row.registrationId}>
                      <td>{row.participantName}</td>
                      <td>{row.programName}</td>
                      <td>{row.divisionName ?? '—'}</td>
                      <td>{row.offeringName}</td>
                      <td>{row.status.replaceAll('_', ' ')}</td>
                      <td>
                        {new Date(row.registeredAt).toLocaleDateString(
                          i18n.language,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {showReports && uniformReport.data ? (
          <div className="table-scroll">
            <table className="ui-table">
              <caption>Uniform sizes by team, division and program</caption>
              <thead>
                <tr>
                  <th scope="col">Program</th>
                  <th scope="col">Division</th>
                  <th scope="col">Team</th>
                  <th scope="col">Item</th>
                  <th scope="col">Size</th>
                  <th scope="col">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {uniformReport.data.items.map((row) => (
                  <tr
                    key={`${row.programId}:${row.addOnKey}:${row.size ?? ''}:${row.teamName ?? ''}`}
                  >
                    <td>{row.programName}</td>
                    <td>{row.divisionName ?? '—'}</td>
                    <td>{row.teamName ?? '—'}</td>
                    <td>{row.addOnName}</td>
                    <td>{row.size ?? 'Unspecified'}</td>
                    <td>{row.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {showReports && uniformReport.data?.items.length === 0 ? (
          <p>No add-on size selections match this report.</p>
        ) : null}
      </section>
      {actionError ? (
        <p role="alert" className="money-error">
          {actionError}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
