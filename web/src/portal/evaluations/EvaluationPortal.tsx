import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Badge, Button, Card, Field, Input, PageHeader } from '../../ui';
import { PortalShell } from '../PortalShell';

import './evaluations.css';

const criterionSchema = z.object({ id: z.uuid(), key: z.string(), label: z.string(), weight: z.coerce.number(), scaleMin: z.coerce.number(), scaleMax: z.coerce.number(), positionSpecific: z.boolean(), positionKeys: z.array(z.string()) });
const participantSchema = z.object({ id: z.uuid(), personId: z.uuid(), bibNumber: z.number(), groupId: z.uuid(), groupName: z.string(), positionKeys: z.array(z.string()), checkInStatus: z.string(), firstName: z.string(), lastName: z.string(), photoFileId: z.string().nullable() });
const scoringSheetSchema = z.object({ event: z.object({ id: z.uuid(), name: z.string(), normalization: z.string(), status: z.string() }), participants: z.array(participantSchema), criteria: z.array(criterionSchema), scores: z.array(z.object({ participantId: z.uuid(), criterionId: z.uuid(), score: z.coerce.number(), notes: z.string().nullable(), clientMutationId: z.uuid(), version: z.number() })) });
const scoreResponseSchema = z.object({ id: z.uuid(), participantId: z.uuid(), criterionId: z.uuid(), version: z.number(), clientMutationId: z.uuid() });
const offerSchema = z.object({ id: z.uuid(), personId: z.uuid(), firstName: z.string(), lastName: z.string(), teamSeasonId: z.uuid(), teamName: z.string(), amountCents: z.coerce.number(), depositCents: z.coerce.number(), expiresAt: z.string(), message: z.string().nullable(), status: z.string(), version: z.number(), acceptanceReady: z.boolean() });
const offersSchema = z.array(offerSchema);
const offerResponseSchema = z.looseObject({ offerId: z.string().optional(), status: z.string().optional(), invoiceId: z.string().optional() });

type QueuedScore = { participantId: string; criterionId: string; score: number; notes: string | null; clientMutationId: string };
const queueSchema = z.array(z.object({ participantId: z.uuid(), criterionId: z.uuid(), score: z.number(), notes: z.string().nullable(), clientMutationId: z.uuid() }));

function readQueue(key: string): QueuedScore[] {
  const raw = sessionStorage.getItem(key);
  if (!raw) return [];
  const parsed = queueSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
}

function scoreKey(score: Pick<QueuedScore, 'participantId' | 'criterionId'>): string { return `${score.participantId}:${score.criterionId}`; }

function ConsentPhoto({ orgId, fileId }: { orgId: string; fileId: string | null }): React.JSX.Element | null {
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (!fileId) return;
    let objectUrl = '';
    const controller = new AbortController();
    void fetch(`/api/v1/files/${fileId}/content`, { credentials: 'include', signal: controller.signal, headers: { 'X-Athlentry-Request': '1', 'X-Athlentry-Org': orgId } })
      .then(async (response) => { if (!response.ok) return; objectUrl = URL.createObjectURL(await response.blob()); setSrc(objectUrl); })
      .catch(() => undefined);
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [fileId, orgId]);
  return src ? <img className="evaluation-athlete-photo" src={src} alt="Athlete profile photo" /> : null;
}

export function EvaluationScoringSheet(): React.JSX.Element {
  const { orgId = '', eventId = '' } = useParams();
  const key = `athlentry.evaluation.queue.${orgId}.${eventId}`;
  const [queue, setQueue] = useState<QueuedScore[]>(() => readQueue(key));
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [notice, setNotice] = useState('');
  const syncing = useRef(false);
  const queryClient = useQueryClient();
  const sheet = useQuery({ queryKey: ['evaluation-scoring-sheet', orgId, eventId], queryFn: () => apiGet(`/evaluations/orgs/${orgId}/events/${eventId}/scoring-sheet`, scoringSheetSchema), enabled: Boolean(orgId && eventId) });
  useEffect(() => { sessionStorage.setItem(key, JSON.stringify(queue)); }, [key, queue]);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);

  const sync = useCallback(async (pending = queue) => {
    if (!navigator.onLine || !pending.length || syncing.current) return;
    syncing.current = true;
    const remaining: QueuedScore[] = [];
    for (const score of pending) {
      try {
        await apiPost(`/evaluations/orgs/${orgId}/events/${eventId}/scores`, score, scoreResponseSchema, score.clientMutationId);
      } catch (cause) {
        remaining.push(score);
        setNotice(cause instanceof Error ? `Some scores remain unsynced: ${cause.message}` : 'Some scores remain unsynced.');
      }
    }
    setQueue((current) => {
      const remainingKeys = new Set(remaining.map((item) => item.clientMutationId));
      const sentIds = new Set(pending.map((item) => item.clientMutationId));
      return [...current.filter((item) => !sentIds.has(item.clientMutationId)), ...remaining.filter((item) => remainingKeys.has(item.clientMutationId))];
    });
    if (remaining.length === 0) setNotice('All saved scores are synced.');
    await queryClient.invalidateQueries({ queryKey: ['evaluation-scoring-sheet', orgId, eventId] });
    syncing.current = false;
  }, [eventId, orgId, queryClient, queue]);

  useEffect(() => { if (online && queue.length) void sync(queue); }, [online, queue, sync]);

  const saveScore = useCallback(async (participantId: string, criterionId: string, score: number, notes: string | null) => {
    const item: QueuedScore = { participantId, criterionId, score, notes, clientMutationId: crypto.randomUUID() };
    const updated = [...queue.filter((queued) => scoreKey(queued) !== scoreKey(item)), item];
    setQueue(updated);
    setNotice(online ? 'Saving score…' : 'Saved on this device. It will sync when the connection returns.');
    if (online) await sync(updated);
  }, [online, queue, sync]);

  const scoreValues = useMemo(() => {
    const values = new Map<string, number>();
    for (const item of sheet.data?.scores ?? []) values.set(scoreKey(item), item.score);
    for (const item of queue) values.set(scoreKey(item), item.score);
    return values;
  }, [queue, sheet.data?.scores]);

  if (!orgId || !eventId) return <main className="console-home">Evaluation unavailable.</main>;
  return <PortalShell orgId={orgId}><main className="console-home evaluation-portal">
    <PageHeader kicker="EVALUATOR" title={sheet.data?.event.name ?? 'Scoring sheet'} description="Score by bib. Evaluators see no family contact information." />
    <div className="evaluation-sync-status" role="status"><Badge tone={online ? 'ok' : 'warn'}>{online ? 'Online' : 'Offline'}</Badge><span>{queue.length} unsynced scores</span><Button secondary type="button" onClick={() => void sync() } disabled={!online || !queue.length}>Sync scores</Button></div>
    {sheet.isPending ? <p role="status">Loading assigned athletes…</p> : sheet.isError ? <p role="alert">{sheet.error.message}. Open this sheet while online before starting offline scoring.</p> : <>
      <div className="evaluation-progress" role="status">{scoreValues.size} score entries saved for {sheet.data.participants.length} assigned athletes.</div>
      <section className="evaluation-score-list" aria-label="Athlete scoring list">
        {sheet.data.participants.map((athlete) => {
          const criteria = sheet.data.criteria.filter((criterion) => !criterion.positionSpecific || !criterion.positionKeys.length || criterion.positionKeys.some((position) => athlete.positionKeys.includes(position)));
          return <Card key={athlete.id} className="evaluation-score-card">
            <div className="evaluation-score-athlete"><div><p className="evaluation-bib">Bib {athlete.bibNumber} · {athlete.groupName}</p><h2>{athlete.firstName} {athlete.lastName}</h2><p>{athlete.positionKeys.join(', ') || 'Position not set'} · {athlete.checkInStatus.replaceAll('_', ' ')}</p></div><ConsentPhoto orgId={orgId} fileId={athlete.photoFileId} /></div>
            {criteria.map((criterion) => {
              const value = scoreValues.get(`${athlete.id}:${criterion.id}`) ?? criterion.scaleMin;
              return <div className="evaluation-score-row" key={criterion.id}><label htmlFor={`score-${athlete.id}-${criterion.id}`}>{criterion.label}</label><input id={`score-${athlete.id}-${criterion.id}`} type="range" min={criterion.scaleMin} max={criterion.scaleMax} step="1" value={value} onChange={(event) => { void saveScore(athlete.id, criterion.id, Number(event.target.value), null); }} /><output htmlFor={`score-${athlete.id}-${criterion.id}`}>{value}</output></div>;
            })}
          </Card>;
        })}
      </section>
      {notice && <p className="evaluation-sync-notice" role="status">{notice}</p>}
    </>}
  </main></PortalShell>;
}

export function FamilyOffers(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const queryClient = useQueryClient();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const offers = useQuery({ queryKey: ['team-offers', orgId], queryFn: () => apiGet(`/evaluations/orgs/${orgId}/me/offers`, offersSchema), enabled: Boolean(orgId) });
  const respond = async (offerId: string, action: 'accept' | 'decline', version: number) => {
    try {
      if (action === 'accept') {
        await apiPost(`/evaluations/orgs/${orgId}/offers/${offerId}/accept`, {}, offerResponseSchema, offerId);
        setNotice('Offer accepted. Your registration and deposit checkout are ready.');
      } else {
        const reason = reasons[offerId]?.trim();
        if (!reason) { setNotice('Add a short reason before declining.'); return; }
        await apiPost(`/evaluations/orgs/${orgId}/offers/${offerId}/decline`, { reason, expectedVersion: version }, offerResponseSchema);
        setNotice('Offer declined. The placement spot is available to the organization.');
      }
      await queryClient.invalidateQueries({ queryKey: ['team-offers', orgId] });
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'The offer response could not be saved.'); }
  };
  return <PortalShell orgId={orgId}><main className="console-home evaluation-portal">
    <PageHeader kicker="TEAM PLACEMENT" title="Team offers" description="Review an offer, choose an installment plan at checkout, or decline with a reason." />
    {offers.isPending ? <p role="status">Loading offers…</p> : offers.isError ? <p role="alert">{offers.error.message}</p> : offers.data.length ? <div className="evaluation-offer-list">{offers.data.map((offer) => <Card key={offer.id}>
      <div className="evaluation-score-athlete"><div><h2>{offer.firstName} {offer.lastName} · {offer.teamName}</h2><p>Offer ${((offer.amountCents ?? 0) / 100).toFixed(2)} · Deposit ${((offer.depositCents ?? 0) / 100).toFixed(2)}</p><p>Respond by {new Date(offer.expiresAt).toLocaleString()}</p>{offer.message && <p>{offer.message}</p>}</div><Badge tone={offer.status === 'accepted' ? 'ok' : offer.status === 'sent' ? 'warn' : 'neutral'}>{offer.status}</Badge></div>
      {offer.status === 'sent' && <div className="evaluation-offer-actions">{offer.acceptanceReady && <Button type="button" onClick={() => void respond(offer.id, 'accept', offer.version)}>Accept and continue to deposit checkout</Button>}
        {!offer.acceptanceReady && <p role="status">Registration checkout is being connected for this offer. You can decline below.</p>}
        <Field label="Reason for declining"><Input value={reasons[offer.id] ?? ''} onChange={(event) => setReasons((current) => ({ ...current, [offer.id]: event.target.value }))} maxLength={2000} /></Field>
        <Button secondary type="button" onClick={() => void respond(offer.id, 'decline', offer.version)}>Decline offer</Button>
      </div>}
    </Card>)}</div> : <Card><p>You have no team offers.</p></Card>}
    {notice && <p className="evaluation-sync-notice" role="status">{notice}</p>}
  </main></PortalShell>;
}
