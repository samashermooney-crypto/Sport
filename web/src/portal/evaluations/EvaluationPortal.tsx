import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPost, apiPut } from '../../api/client';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../../ui';
import { PortalShell } from '../PortalShell';

import './evaluations.css';

const criterionSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string(),
  weight: z.coerce.number(),
  scaleMin: z.coerce.number(),
  scaleMax: z.coerce.number(),
  positionSpecific: z.boolean(),
  positionKeys: z.array(z.string()),
});
const participantSchema = z.object({
  id: z.uuid(),
  personId: z.uuid(),
  bibNumber: z.number(),
  groupId: z.uuid(),
  groupName: z.string(),
  positionKeys: z.array(z.string()),
  checkInStatus: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  photoFileId: z.string().nullable(),
});
const scoringSheetSchema = z.object({
  event: z.object({
    id: z.uuid(),
    name: z.string(),
    normalization: z.string(),
    status: z.string(),
  }),
  participants: z.array(participantSchema),
  criteria: z.array(criterionSchema),
  scores: z.array(
    z.object({
      participantId: z.uuid(),
      criterionId: z.uuid(),
      score: z.coerce.number(),
      notes: z.string().nullable(),
      clientMutationId: z.uuid(),
      version: z.number(),
    }),
  ),
});
const scoreResponseSchema = z.object({
  id: z.uuid(),
  participantId: z.uuid(),
  criterionId: z.uuid(),
  version: z.number(),
  clientMutationId: z.uuid(),
});
const offerSchema = z.object({
  id: z.uuid(),
  personId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  teamSeasonId: z.uuid(),
  teamName: z.string(),
  amountCents: z.coerce.number(),
  depositCents: z.coerce.number(),
  expiresAt: z.string(),
  message: z.string().nullable(),
  status: z.string(),
  version: z.number(),
  acceptanceReady: z.boolean(),
});
const offersSchema = z.array(offerSchema);
const offerResponseSchema = z.looseObject({
  offerId: z.string().optional(),
  status: z.string().optional(),
  invoiceId: z.string().optional(),
});

type QueuedScore = {
  participantId: string;
  criterionId: string;
  score: number;
  notes: string | null;
  clientMutationId: string;
};
const queueSchema = z.array(
  z.object({
    participantId: z.uuid(),
    criterionId: z.uuid(),
    score: z.number(),
    notes: z.string().nullable(),
    clientMutationId: z.uuid(),
  }),
);

function readQueue(key: string): QueuedScore[] {
  const raw = sessionStorage.getItem(key);
  if (!raw) return [];
  const parsed = queueSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
}

function scoreKey(
  score: Pick<QueuedScore, 'participantId' | 'criterionId'>,
): string {
  return `${score.participantId}:${score.criterionId}`;
}

function ConsentPhoto({
  orgId,
  fileId,
}: {
  orgId: string;
  fileId: string | null;
}): React.JSX.Element | null {
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (!fileId) return;
    let objectUrl = '';
    const controller = new AbortController();
    void fetch(`/api/v1/files/${fileId}/content`, {
      credentials: 'include',
      signal: controller.signal,
      headers: { 'X-Athlentry-Request': '1', 'X-Athlentry-Org': orgId },
    })
      .then(async (response) => {
        if (!response.ok) return;
        objectUrl = URL.createObjectURL(await response.blob());
        setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId, orgId]);
  return src ? (
    <img
      className="evaluation-athlete-photo"
      src={src}
      alt="Athlete profile photo"
    />
  ) : null;
}

export function EvaluationScoringSheet(): React.JSX.Element {
  const { orgId = '', eventId = '' } = useParams();
  const key = `athlentry.evaluation.queue.${orgId}.${eventId}`;
  const [queue, setQueue] = useState<QueuedScore[]>(() => readQueue(key));
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [online, setOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  );
  const [notice, setNotice] = useState('');
  const syncing = useRef(false);
  const autoSyncAttempt = useRef('');
  const queryClient = useQueryClient();
  const sheet = useQuery({
    queryKey: ['evaluation-scoring-sheet', orgId, eventId],
    queryFn: () =>
      apiGet(
        `/evaluations/orgs/${orgId}/events/${eventId}/scoring-sheet`,
        scoringSheetSchema,
      ),
    enabled: Boolean(orgId && eventId),
  });
  useEffect(() => {
    sessionStorage.setItem(key, JSON.stringify(queue));
  }, [key, queue]);
  useEffect(() => {
    const changed = () => {
      setOnline(navigator.onLine);
    };
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    return () => {
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
    };
  }, []);

  const sync = useCallback(
    async (pending = queue) => {
      if (!navigator.onLine || !pending.length || syncing.current) return;
      syncing.current = true;
      try {
        const remaining: QueuedScore[] = [];
        for (const score of pending) {
          try {
            await apiPost(
              `/evaluations/orgs/${orgId}/events/${eventId}/scores`,
              score,
              scoreResponseSchema,
              score.clientMutationId,
            );
          } catch (cause) {
            remaining.push(score);
            setNotice(
              cause instanceof Error
                ? `Some scores remain unsynced: ${cause.message}`
                : 'Some scores remain unsynced.',
            );
          }
        }
        setQueue((current) => {
          const sentIds = new Set(pending.map((item) => item.clientMutationId));
          return [
            ...current.filter((item) => !sentIds.has(item.clientMutationId)),
            ...remaining,
          ];
        });
        if (remaining.length === 0) setNotice('All saved scores are synced.');
        await queryClient.invalidateQueries({
          queryKey: ['evaluation-scoring-sheet', orgId, eventId],
        });
      } finally {
        syncing.current = false;
      }
    },
    [eventId, orgId, queryClient, queue],
  );

  const queueRef = useRef(queue);
  const syncRef = useRef(sync);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);
  useEffect(() => {
    if (!online) {
      autoSyncAttempt.current = '';
      return;
    }
    const pending = queueRef.current;
    if (!pending.length) return;
    const signature = pending.map((item) => item.clientMutationId).join(':');
    if (signature === autoSyncAttempt.current) return;
    autoSyncAttempt.current = signature;
    void syncRef.current(pending);
  }, [online]);

  const saveScore = useCallback(
    async (
      participantId: string,
      criterionId: string,
      score: number,
      notes: string | null,
    ) => {
      const item: QueuedScore = {
        participantId,
        criterionId,
        score,
        notes,
        clientMutationId: crypto.randomUUID(),
      };
      const updated = [
        ...queue.filter((queued) => scoreKey(queued) !== scoreKey(item)),
        item,
      ];
      setQueue(updated);
      setNotice(
        online
          ? 'Saving score…'
          : 'Saved on this device. It will sync when the connection returns.',
      );
      if (online) await sync(updated);
    },
    [online, queue, sync],
  );

  const scoreValues = useMemo(() => {
    const values = new Map<string, number>();
    for (const item of sheet.data?.scores ?? [])
      values.set(scoreKey(item), item.score);
    for (const item of queue) values.set(scoreKey(item), item.score);
    return values;
  }, [queue, sheet.data?.scores]);
  const noteValues = useMemo(() => {
    const values = new Map<string, string | null>();
    for (const item of sheet.data?.scores ?? [])
      values.set(scoreKey(item), item.notes);
    for (const item of queue) values.set(scoreKey(item), item.notes);
    return values;
  }, [queue, sheet.data?.scores]);

  if (!orgId || !eventId)
    return <main className="console-home">Evaluation unavailable.</main>;
  return (
    <PortalShell orgId={orgId}>
      <main className="console-home evaluation-portal">
        <PageHeader
          kicker="EVALUATOR"
          title={sheet.data?.event.name ?? 'Scoring sheet'}
          description="Score by bib. Evaluators see no family contact information."
        />
        <div className="evaluation-sync-status" role="status">
          <Badge tone={online ? 'ok' : 'warn'}>
            {online ? 'Online' : 'Offline'}
          </Badge>
          <span>{queue.length} unsynced scores</span>
          <Button
            secondary
            type="button"
            onClick={() => void sync()}
            disabled={!online || !queue.length}
          >
            Sync scores
          </Button>
        </div>
        {sheet.isPending ? (
          <p role="status">Loading assigned athletes…</p>
        ) : sheet.isError ? (
          <p role="alert">
            {sheet.error.message}. Open this sheet while online before starting
            offline scoring.
          </p>
        ) : (
          <>
            <div className="evaluation-progress" role="status">
              {scoreValues.size} score entries saved for{' '}
              {sheet.data.participants.length} assigned athletes.
            </div>
            <section
              className="evaluation-score-list"
              aria-label="Athlete scoring list"
            >
              {sheet.data.participants.map((athlete) => {
                const criteria = sheet.data.criteria.filter(
                  (criterion) =>
                    !criterion.positionSpecific ||
                    !criterion.positionKeys.length ||
                    criterion.positionKeys.some((position) =>
                      athlete.positionKeys.includes(position),
                    ),
                );
                return (
                  <Card key={athlete.id} className="evaluation-score-card">
                    <div className="evaluation-score-athlete">
                      <div>
                        <p className="evaluation-bib">
                          Bib {athlete.bibNumber} · {athlete.groupName}
                        </p>
                        <h2>
                          {athlete.firstName} {athlete.lastName}
                        </h2>
                        <p>
                          {athlete.positionKeys.join(', ') ||
                            'Position not set'}{' '}
                          · {athlete.checkInStatus.replaceAll('_', ' ')}
                        </p>
                      </div>
                      <ConsentPhoto
                        orgId={orgId}
                        fileId={athlete.photoFileId}
                      />
                    </div>
                    {criteria.map((criterion) => {
                      const key = `${athlete.id}:${criterion.id}`;
                      const value = scoreValues.get(key) ?? criterion.scaleMin;
                      const notes =
                        noteDrafts[key] ?? noteValues.get(key) ?? '';
                      return (
                        <div
                          className="evaluation-score-entry"
                          key={criterion.id}
                        >
                          <div className="evaluation-score-row">
                            <label
                              htmlFor={`score-${athlete.id}-${criterion.id}`}
                            >
                              {criterion.label}
                            </label>
                            <input
                              id={`score-${athlete.id}-${criterion.id}`}
                              type="range"
                              min={criterion.scaleMin}
                              max={criterion.scaleMax}
                              step="1"
                              value={value}
                              onChange={(event) => {
                                void saveScore(
                                  athlete.id,
                                  criterion.id,
                                  Number(event.target.value),
                                  notes || null,
                                );
                              }}
                            />
                            <output
                              htmlFor={`score-${athlete.id}-${criterion.id}`}
                            >
                              {value}
                            </output>
                          </div>
                          <Field label={`${criterion.label} notes`}>
                            <Textarea
                              value={notes}
                              maxLength={4000}
                              onChange={(event) => {
                                setNoteDrafts((current) => ({
                                  ...current,
                                  [key]: event.target.value,
                                }));
                              }}
                              onBlur={(event) => {
                                void saveScore(
                                  athlete.id,
                                  criterion.id,
                                  scoreValues.get(key) ?? criterion.scaleMin,
                                  event.target.value.trim() || null,
                                );
                              }}
                            />
                          </Field>
                        </div>
                      );
                    })}
                  </Card>
                );
              })}
            </section>
            {notice && (
              <p className="evaluation-sync-notice" role="status">
                {notice}
              </p>
            )}
          </>
        )}
      </main>
    </PortalShell>
  );
}

export function FamilyOffers(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const queryClient = useQueryClient();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const offers = useQuery({
    queryKey: ['team-offers', orgId],
    queryFn: () => apiGet(`/evaluations/orgs/${orgId}/me/offers`, offersSchema),
    enabled: Boolean(orgId),
  });
  const respond = async (
    offerId: string,
    action: 'accept' | 'decline',
    version: number,
  ) => {
    try {
      if (action === 'accept') {
        await apiPost(
          `/evaluations/orgs/${orgId}/offers/${offerId}/accept`,
          {},
          offerResponseSchema,
          offerId,
        );
        setNotice(
          'Offer accepted. Your registration and deposit checkout are ready.',
        );
      } else {
        const reason = reasons[offerId]?.trim();
        if (!reason) {
          setNotice('Add a short reason before declining.');
          return;
        }
        await apiPost(
          `/evaluations/orgs/${orgId}/offers/${offerId}/decline`,
          { reason, expectedVersion: version },
          offerResponseSchema,
        );
        setNotice(
          'Offer declined. The placement spot is available to the organization.',
        );
      }
      await queryClient.invalidateQueries({ queryKey: ['team-offers', orgId] });
    } catch (cause) {
      setNotice(
        cause instanceof Error
          ? cause.message
          : 'The offer response could not be saved.',
      );
    }
  };
  return (
    <PortalShell orgId={orgId}>
      <main className="console-home evaluation-portal">
        <PageHeader
          kicker="TEAM PLACEMENT"
          title="Team offers"
          description="Review an offer, choose an installment plan at checkout, or decline with a reason."
        />
        {offers.isPending ? (
          <p role="status">Loading offers…</p>
        ) : offers.isError ? (
          <p role="alert">{offers.error.message}</p>
        ) : offers.data.length ? (
          <div className="evaluation-offer-list">
            {offers.data.map((offer) => (
              <Card key={offer.id}>
                <div className="evaluation-score-athlete">
                  <div>
                    <h2>
                      {offer.firstName} {offer.lastName} · {offer.teamName}
                    </h2>
                    <p>
                      Offer ${(offer.amountCents / 100).toFixed(2)} · Deposit $
                      {(offer.depositCents / 100).toFixed(2)}
                    </p>
                    <p>
                      Respond by {new Date(offer.expiresAt).toLocaleString()}
                    </p>
                    {offer.message && <p>{offer.message}</p>}
                  </div>
                  <Badge
                    tone={
                      offer.status === 'accepted'
                        ? 'ok'
                        : offer.status === 'sent'
                          ? 'warn'
                          : 'neutral'
                    }
                  >
                    {offer.status}
                  </Badge>
                </div>
                {offer.status === 'sent' && (
                  <div className="evaluation-offer-actions">
                    {offer.acceptanceReady && (
                      <Button
                        type="button"
                        onClick={() =>
                          void respond(offer.id, 'accept', offer.version)
                        }
                      >
                        Accept and continue to deposit checkout
                      </Button>
                    )}
                    {!offer.acceptanceReady && (
                      <p role="status">
                        Registration checkout is being connected for this offer.
                        You can decline below.
                      </p>
                    )}
                    <Field label="Reason for declining">
                      <Input
                        value={reasons[offer.id] ?? ''}
                        onChange={(event) => {
                          setReasons((current) => ({
                            ...current,
                            [offer.id]: event.target.value,
                          }));
                        }}
                        maxLength={2000}
                      />
                    </Field>
                    <Button
                      secondary
                      type="button"
                      onClick={() =>
                        void respond(offer.id, 'decline', offer.version)
                      }
                    >
                      Decline offer
                    </Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <p>You have no team offers.</p>
          </Card>
        )}
        {notice && (
          <p className="evaluation-sync-notice" role="status">
            {notice}
          </p>
        )}
      </main>
    </PortalShell>
  );
}

const resultSchema = z.object({
  eventId: z.uuid(),
  eventName: z.string(),
  participantId: z.uuid(),
  personId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  group: z.string(),
  composite: z.number().nullable(),
  rankInGroup: z.number().nullable(),
  evaluatorCount: z.number(),
  criterionValues: z.record(z.string(), z.number()),
});
const resultsListSchema = z.array(resultSchema);

export function FamilyResults(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const results = useQuery({
    queryKey: ['evaluation-family-results', orgId],
    queryFn: () =>
      apiGet(`/evaluations/orgs/${orgId}/me/results`, resultsListSchema),
    enabled: Boolean(orgId),
  });
  return (
    <PortalShell orgId={orgId}>
      <main className="console-home evaluation-portal">
        <PageHeader
          kicker="TRYOUTS"
          title="Evaluation results"
          description="Results are shared only when the organization chooses to release them."
        />
        {results.isPending ? (
          <p role="status">Loading results…</p>
        ) : results.isError ? (
          <p role="alert">{results.error.message}</p>
        ) : results.data.length ? (
          <div className="evaluation-offer-list">
            {results.data.map((row) => (
              <Card key={row.participantId}>
                <div className="evaluation-score-athlete">
                  <div>
                    <h2>
                      {row.firstName} {row.lastName}
                    </h2>
                    <p>
                      {row.eventName} · {row.group}
                    </p>
                    {Object.keys(row.criterionValues).length > 0 && (
                      <p>
                        {Object.entries(row.criterionValues)
                          .map(([key, value]) => `${key}: ${value.toFixed(1)}`)
                          .join(' · ')}
                      </p>
                    )}
                  </div>
                  <Badge tone={row.composite === null ? 'neutral' : 'ok'}>
                    {row.composite === null
                      ? 'Incomplete'
                      : `Rank ${String(row.rankInGroup ?? '—')} · ${row.composite.toFixed(2)}`}
                  </Badge>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <p>No shared evaluation results.</p>
          </Card>
        )}
      </main>
    </PortalShell>
  );
}

const placementProgramsSchema = z.array(
  z.object({
    programId: z.uuid(),
    programName: z.string(),
    personId: z.uuid(),
    firstName: z.string(),
    lastName: z.string(),
    divisionId: z.uuid(),
    divisionName: z.string(),
    friendRequestPersonId: z.uuid().nullable(),
    practiceLocation: z.string().nullable(),
  }),
);

export function FamilyPlacementPreferences(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState('');
  const [friendRequestPersonId, setFriendRequestPersonId] = useState('');
  const [practiceLocation, setPracticeLocation] = useState('');
  const [notice, setNotice] = useState('');
  const programs = useQuery({
    queryKey: ['my-placement-programs', orgId],
    queryFn: () =>
      apiGet(
        `/evaluations/orgs/${orgId}/me/placement-programs`,
        placementProgramsSchema,
      ),
    enabled: Boolean(orgId),
  });
  const selected = programs.data?.find(
    (row) => `${row.programId}:${row.personId}` === selection,
  );
  useEffect(() => {
    if (!selected) return;
    setFriendRequestPersonId(selected.friendRequestPersonId ?? '');
    setPracticeLocation(selected.practiceLocation ?? '');
  }, [selected]);
  const save = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Choose a registered athlete first.');
      const friendId = friendRequestPersonId.trim();
      if (friendId && !z.uuid().safeParse(friendId).success)
        throw new Error(
          'Enter a valid shared athlete ID for the mutual friend request.',
        );
      return apiPut(
        `/evaluations/orgs/${orgId}/me/programs/${selected.programId}/placement-preference`,
        {
          personId: selected.personId,
          friendRequestPersonId: friendId || null,
          practiceLocation: practiceLocation.trim() || null,
        },
        z.looseObject({ id: z.uuid(), version: z.number() }),
      );
    },
    onSuccess: async () => {
      setNotice(
        'Placement preferences saved. Friend requests are honored when they are mutual.',
      );
      await queryClient.invalidateQueries({
        queryKey: ['my-placement-programs', orgId],
      });
    },
    onError: (cause) => {
      setNotice(
        cause instanceof Error
          ? cause.message
          : 'Placement preferences could not be saved.',
      );
    },
  });
  return (
    <PortalShell orgId={orgId}>
      <main className="console-home evaluation-portal">
        <PageHeader
          kicker="TEAM PLACEMENT"
          title="Placement preferences"
          description="Share a practice location and request a mutual friend grouping for rec league team formation."
        />
        <nav className="evaluation-family-links" aria-label="Evaluation pages">
          <Link to={`/portal/orgs/${orgId}/offers`}>Team offers</Link>
          <Link to={`/portal/orgs/${orgId}/results`}>Evaluation results</Link>
        </nav>
        {programs.isPending ? (
          <p role="status">Loading registered programs…</p>
        ) : programs.isError ? (
          <p role="alert">{programs.error.message}</p>
        ) : programs.data.length ? (
          <Card>
            <form
              className="evaluation-form"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate();
              }}
            >
              <Field label="Registered athlete and program" required>
                <Select
                  required
                  value={selection}
                  onChange={(event) => {
                    setSelection(event.target.value);
                  }}
                >
                  <option value="">Choose an athlete</option>
                  {programs.data.map((row) => (
                    <option
                      key={`${row.programId}:${row.personId}`}
                      value={`${row.programId}:${row.personId}`}
                    >
                      {row.firstName} {row.lastName} · {row.programName} ·{' '}
                      {row.divisionName}
                    </option>
                  ))}
                </Select>
              </Field>
              {selected && (
                <>
                  <Field
                    label="Mutual friend request athlete ID"
                    hint="Share athlete IDs directly with the other family; the request is used only if both families request each other."
                  >
                    <Input
                      value={friendRequestPersonId}
                      onChange={(event) => {
                        setFriendRequestPersonId(event.target.value);
                      }}
                    />
                  </Field>
                  <Field label="Preferred practice location">
                    <Input
                      maxLength={160}
                      value={practiceLocation}
                      onChange={(event) => {
                        setPracticeLocation(event.target.value);
                      }}
                    />
                  </Field>
                  <Button type="submit" disabled={save.isPending}>
                    {save.isPending ? 'Saving…' : 'Save preferences'}
                  </Button>
                </>
              )}
            </form>
          </Card>
        ) : (
          <Card>
            <p>No active rec-league registrations are linked to this family.</p>
          </Card>
        )}
        {notice && (
          <p className="evaluation-sync-notice" role="status">
            {notice}
          </p>
        )}
      </main>
    </PortalShell>
  );
}
