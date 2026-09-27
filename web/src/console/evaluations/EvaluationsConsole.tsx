import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Badge, Button, Card, Field, Input, PageHeader } from '../../ui';
import { AppShell } from '../../ui/shell';

import './evaluations.css';

const eventSchema = z.object({ id: z.uuid(), name: z.string(), status: z.string(), normalization: z.string(), tryoutProgramId: z.string(), targetProgramId: z.string(), targetProgramName: z.string(), participantCount: z.number(), version: z.number() });
const eventsSchema = z.array(eventSchema);
const setupSchema = z.object({
  event: z.looseObject({ id: z.uuid(), name: z.string(), status: z.string(), normalization: z.string() }),
  groups: z.array(z.looseObject({ id: z.uuid(), name: z.string(), ageMinMonths: z.number().nullable(), ageMaxMonths: z.number().nullable(), gender: z.string().nullable(), positionKeys: z.array(z.string()) })),
  sessions: z.array(z.looseObject({ id: z.uuid(), groupId: z.string().nullable(), name: z.string(), startsAt: z.string(), endsAt: z.string(), timezone: z.string() })),
  participants: z.array(z.looseObject({ id: z.uuid(), personId: z.uuid(), groupId: z.uuid(), groupName: z.string(), sessionId: z.string().nullable(), bibNumber: z.number(), checkInStatus: z.string(), firstName: z.string(), lastName: z.string() })),
});
const resultsSchema = z.array(z.looseObject({ participantId: z.uuid(), group: z.string(), firstName: z.string(), lastName: z.string(), composite: z.number().nullable(), rankInGroup: z.number().nullable(), evaluatorCount: z.number(), missingCriteria: z.array(z.string()) }));
const boardSchema = z.object({ id: z.uuid(), targetProgramId: z.uuid(), divisionId: z.string().nullable(), seed: z.number(), assignments: z.record(z.string(), z.string()), metrics: z.array(z.looseObject({ teamId: z.string(), size: z.number(), meanRating: z.number(), positionCoverageViolations: z.number(), preferenceMisses: z.number() })), objective: z.number() });
const boardDetailSchema = z.object({ id: z.uuid(), status: z.string(), metrics: z.unknown(), placements: z.array(z.looseObject({ personId: z.uuid(), firstName: z.string(), lastName: z.string(), teamSeasonId: z.uuid(), teamName: z.string(), rating: z.coerce.number().nullable(), locked: z.boolean(), status: z.string(), version: z.number() })) });
const responseSchema = z.looseObject({ id: z.string().optional(), status: z.string().optional() });

async function downloadEvaluationCsv(orgId: string, eventId: string): Promise<void> {
  const response = await fetch(`/api/v1/evaluations/orgs/${orgId}/events/${eventId}/export.csv`, {
    method: 'POST', credentials: 'include', headers: { 'X-Athlentry-Request': '1', 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!response.ok) throw new Error('CSV export is unavailable. Complete step-up authentication and try again.');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = `evaluation-${eventId}.csv`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function OrgLayout({ orgId, children, title, description }: { orgId: string; children: React.ReactNode; title: string; description: string }) {
  const workspace = useQuery({ queryKey: ['orgs', orgId, 'workspace'], queryFn: () => apiGet(`/orgs/${orgId}/workspace`, z.looseObject({ name: z.string().optional() })) });
  return <AppShell orgName={workspace.data?.name ?? 'Athlentry'} navigation={[{ label: 'Manage', items: [{ label: 'Home', to: `/console/orgs/${orgId}` }, { label: 'Evaluations', to: `/console/orgs/${orgId}/evaluations` }] }]} mobileTabs={[{ label: 'Home', to: `/console/orgs/${orgId}` }, { label: 'Evaluations', to: `/console/orgs/${orgId}/evaluations` }]}>
    <main className="console-home evaluation-console"><PageHeader kicker="PLAYER DEVELOPMENT" title={title} description={description} />{children}</main>
  </AppShell>;
}

export function EvaluationList(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [tryoutProgramId, setTryoutProgramId] = useState('');
  const [targetProgramId, setTargetProgramId] = useState('');
  const [error, setError] = useState('');
  const events = useQuery({ queryKey: ['evaluations', orgId], queryFn: () => apiGet(`/evaluations/orgs/${orgId}/events`, eventsSchema), enabled: Boolean(orgId) });
  const create = useMutation({
    mutationFn: () => apiPost(`/evaluations/orgs/${orgId}/events`, {
      name, tryoutProgramId, targetProgramId, normalization: 'z_score_per_evaluator', shareResultsWithFamilies: false,
      criteria: [
        { key: 'speed', label: 'Speed', weight: 1, scaleMin: 1, scaleMax: 5 },
        { key: 'skill', label: 'Sport skill', weight: 1, scaleMin: 1, scaleMax: 5 },
        { key: 'awareness', label: 'Game awareness', weight: 1, scaleMin: 1, scaleMax: 5 },
      ],
      groups: [{ name: 'Open', ageMinMonths: null, ageMaxMonths: null, gender: 'open', positionKeys: [] }],
    }, responseSchema),
    onSuccess: async () => { setName(''); setError(''); await queryClient.invalidateQueries({ queryKey: ['evaluations', orgId] }); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : 'Evaluation event could not be created.'),
  });
  return <OrgLayout orgId={orgId} title="Evaluations and tryouts" description="Set up a tryout, review results and build balanced teams.">
    <section className="evaluation-grid">
      <Card><h2>Create an evaluation</h2><p>Use a tryout program and the target program you will place athletes into.</p>
        <form className="evaluation-form" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
          <Field label="Event name" required><Input required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="Tryout program ID" required hint="Choose the program in registration mode 'tryout'."><Input required value={tryoutProgramId} onChange={(event) => setTryoutProgramId(event.target.value)} /></Field>
          <Field label="Target program ID" required><Input required value={targetProgramId} onChange={(event) => setTargetProgramId(event.target.value)} /></Field>
          <p className="field-hint">Default rubric: Speed, Sport skill and Game awareness, each scored 1–5 with equal weight. Results are not shared with families.</p>
          {error && <p role="alert" className="field-error">{error}</p>}
          <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create evaluation'}</Button>
        </form>
      </Card>
      <Card><h2>Evaluation events</h2>
        {events.isPending ? <p role="status">Loading events…</p> : events.isError ? <p role="alert">{events.error.message}</p> : events.data?.length ? <ul className="evaluation-event-list">{events.data.map((item) => <li key={item.id}>
          <div><Link to={`/console/orgs/${orgId}/evaluations/${item.id}`}>{item.name}</Link><p>{item.targetProgramName} · {item.participantCount} athletes</p></div>
          <Badge tone={item.status === 'published' ? 'ok' : 'neutral'}>{item.status}</Badge>
        </li>)}</ul> : <p>No evaluation events yet.</p>}
      </Card>
    </section>
  </OrgLayout>;
}

export function EvaluationOperations(): React.JSX.Element {
  const { orgId = '', eventId = '' } = useParams();
  const queryClient = useQueryClient();
  const [sessionName, setSessionName] = useState('Tryout session');
  const [sessionStart, setSessionStart] = useState('');
  const [sessionEnd, setSessionEnd] = useState('');
  const [personId, setPersonId] = useState('');
  const [positionKeys, setPositionKeys] = useState('');
  const [divisionId, setDivisionId] = useState('');
  const [boardId, setBoardId] = useState('');
  const [seed, setSeed] = useState('1');
  const [offerOfferingId, setOfferOfferingId] = useState('');
  const [offerAmount, setOfferAmount] = useState('');
  const [offerDeposit, setOfferDeposit] = useState('');
  const [offerExpires, setOfferExpires] = useState('');
  const [notice, setNotice] = useState('');
  const setup = useQuery({ queryKey: ['evaluation-setup', orgId, eventId], queryFn: () => apiGet(`/evaluations/orgs/${orgId}/events/${eventId}/setup`, setupSchema), enabled: Boolean(orgId && eventId) });
  const results = useQuery({ queryKey: ['evaluation-results', orgId, eventId], queryFn: () => apiGet(`/evaluations/orgs/${orgId}/events/${eventId}/results`, resultsSchema), enabled: false });
  const board = useQuery({ queryKey: ['evaluation-board', orgId, boardId], queryFn: () => apiGet(`/evaluations/orgs/${orgId}/boards/${boardId}`, boardDetailSchema), enabled: Boolean(boardId) });
  const session = useMutation({ mutationFn: (groupId: string | null) => apiPost(`/evaluations/orgs/${orgId}/events/${eventId}/sessions`, { name: sessionName, groupId, startsAt: new Date(sessionStart).toISOString(), endsAt: new Date(sessionEnd).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago', facilityId: null, capacity: null }, responseSchema), onSuccess: async () => { setNotice('Session saved.'); await queryClient.invalidateQueries({ queryKey: ['evaluation-setup', orgId, eventId] }); }, onError: (cause) => setNotice(cause instanceof Error ? cause.message : 'Session could not be saved.') });
  const participant = useMutation({ mutationFn: () => apiPost(`/evaluations/orgs/${orgId}/events/${eventId}/participants`, { personId, groupId: null, sessionId: null, registrationId: null, positionKeys: positionKeys.split(',').map((value) => value.trim()).filter(Boolean) }, responseSchema), onSuccess: async () => { setPersonId(''); setNotice('Athlete assigned a bib.'); await queryClient.invalidateQueries({ queryKey: ['evaluation-setup', orgId, eventId] }); }, onError: (cause) => setNotice(cause instanceof Error ? cause.message : 'Athlete could not be assigned.') });
  const checkIn = useMutation({ mutationFn: (participantId: string) => apiPost(`/evaluations/orgs/${orgId}/participants/${participantId}/check-in`, { late: false }, responseSchema), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['evaluation-setup', orgId, eventId] }); } });
  const compute = useMutation({ mutationFn: () => apiPost(`/evaluations/orgs/${orgId}/events/${eventId}/compute-results`, {}, z.array(z.looseObject({ participantId: z.string() }))), onSuccess: async () => { await results.refetch(); setNotice('Normalized results are ready.'); }, onError: (cause) => setNotice(cause instanceof Error ? cause.message : 'Results could not be computed.') });
  const createBoard = useMutation({ mutationFn: () => apiPost(`/evaluations/orgs/${orgId}/events/${eventId}/boards`, { divisionId: divisionId || null, seed: Number(seed), siblingsTogether: true, returningStay: false }, boardSchema), onSuccess: async (value) => { setBoardId(value.id); await queryClient.invalidateQueries({ queryKey: ['evaluation-board', orgId, value.id] }); setNotice('Placement draft balanced.'); }, onError: (cause) => setNotice(cause instanceof Error ? cause.message : 'Placement board could not be created.') });
  const publish = useMutation({ mutationFn: () => apiPost(`/evaluations/orgs/${orgId}/boards/${boardId}/publish`, {}, responseSchema), onSuccess: async () => { await board.refetch(); setNotice('Placement board published.'); } });
  const offer = useMutation({ mutationFn: (placementId: string) => apiPost(`/evaluations/orgs/${orgId}/placements/${placementId}/offers`, { offeringId: offerOfferingId, amountCents: Number(offerAmount), depositCents: Number(offerDeposit), expiresAt: new Date(offerExpires).toISOString(), message: null }, responseSchema), onSuccess: () => setNotice('Offer recorded for the family.') });
  const heading = setup.data?.event.name ?? 'Evaluation event';
  const sortedResults = useMemo(() => results.data ?? [], [results.data]);
  return <OrgLayout orgId={orgId} title={heading} description="Schedule sessions, check in athletes, compute normalized results and balance the placement board.">
    {setup.isPending ? <p role="status">Loading evaluation setup…</p> : setup.isError ? <p role="alert">{setup.error.message}</p> : <>
      <section className="evaluation-grid">
        <Card><h2>Schedule a session</h2><form className="evaluation-form" onSubmit={(event) => { event.preventDefault(); session.mutate(null); }}>
          <Field label="Session name"><Input value={sessionName} onChange={(event) => setSessionName(event.target.value)} /></Field>
          <Field label="Starts"><Input type="datetime-local" required value={sessionStart} onChange={(event) => setSessionStart(event.target.value)} /></Field>
          <Field label="Ends"><Input type="datetime-local" required value={sessionEnd} onChange={(event) => setSessionEnd(event.target.value)} /></Field>
          <Button type="submit" disabled={session.isPending}>Add session</Button>
        </form>
        <ul>{setup.data.sessions.map((item) => <li key={item.id}>{item.name} · {new Date(item.startsAt).toLocaleString()}</li>)}</ul></Card>
        <Card><h2>Assign an athlete</h2><p>Group assignment uses the athlete’s age, competition gender and positions.</p>
          <form className="evaluation-form" onSubmit={(event) => { event.preventDefault(); participant.mutate(); }}>
            <Field label="Person ID"><Input required value={personId} onChange={(event) => setPersonId(event.target.value)} /></Field>
            <Field label="Positions"><Input value={positionKeys} onChange={(event) => setPositionKeys(event.target.value)} placeholder="Forward, midfield" /></Field>
            <Button type="submit" disabled={participant.isPending}>Assign bib</Button>
          </form>
        </Card>
      </section>
      <Card className="evaluation-checkin"><div className="evaluation-card-heading"><div><h2>Check-in and bib list</h2><p>Names and bibs only; no family contact details.</p></div><Button secondary type="button" onClick={() => window.print()}>Print bib sheet</Button></div>
        {setup.data.participants.length ? <div className="evaluation-table-wrap"><table><thead><tr><th>Bib</th><th>Athlete</th><th>Group</th><th>Status</th><th>Action</th></tr></thead><tbody>{setup.data.participants.map((row) => <tr key={row.id}><td>{row.bibNumber}</td><td>{row.firstName} {row.lastName}</td><td>{row.groupName}</td><td>{row.checkInStatus}</td><td>{row.checkInStatus === 'expected' ? <Button type="button" secondary onClick={() => checkIn.mutate(row.id)}>Check in</Button> : <Badge tone="ok">Checked in</Badge>}</td></tr>)}</tbody></table></div> : <p>No participants assigned.</p>}
      </Card>
      <section className="evaluation-grid">
        <Card><h2>Results</h2><p>Scoring uses the shared evaluator normalization policy; athletes with fewer than two evaluators are flagged.</p>
          <Button onClick={() => compute.mutate()} disabled={compute.isPending}>Compute normalized results</Button>
          {sortedResults.length > 0 && <div className="evaluation-table-wrap"><table><thead><tr><th>Rank</th><th>Athlete</th><th>Group</th><th>Composite</th><th>Evaluators</th></tr></thead><tbody>{sortedResults.map((row) => <tr key={row.participantId}><td>{row.rankInGroup ?? '—'}</td><td>{row.firstName} {row.lastName}</td><td>{row.group}</td><td>{row.composite?.toFixed(2) ?? 'Incomplete'}</td><td>{row.evaluatorCount}{row.evaluatorCount < 2 ? ' · second evaluator needed' : ''}</td></tr>)}</tbody></table></div>}
          {results.isError && <p role="alert">{results.error.message}</p>}
          <Button secondary type="button" onClick={() => void downloadEvaluationCsv(orgId, eventId).catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : 'Export unavailable.'))}>Export results CSV</Button>
        </Card>
        <Card><h2>Placement board</h2><p>Teams are balanced with fixed coach-family placements and optional sibling grouping.</p>
          <Field label="Division ID (leave blank for a single age group)"><Input value={divisionId} onChange={(event) => setDivisionId(event.target.value)} /></Field>
          <Field label="Deterministic seed"><Input inputMode="numeric" value={seed} onChange={(event) => setSeed(event.target.value)} /></Field>
          <Button onClick={() => createBoard.mutate()} disabled={createBoard.isPending}>Build placement draft</Button>
          {boardId && <p>Board <code>{boardId}</code></p>}
          {board.data?.placements.map((row) => <div className="evaluation-placement" key={row.personId}><span>{row.firstName} {row.lastName} → {row.teamName}</span><Badge tone={row.locked ? 'warn' : 'neutral'}>{row.status}</Badge>
            <form onSubmit={(event) => { event.preventDefault(); offer.mutate(row.personId); }} className="evaluation-offer-form">
              <Input aria-label="Registration offering ID" placeholder="Offering ID" value={offerOfferingId} onChange={(event) => setOfferOfferingId(event.target.value)} required />
              <Input aria-label="Offer fee in cents" inputMode="numeric" placeholder="Fee cents" value={offerAmount} onChange={(event) => setOfferAmount(event.target.value)} required />
              <Input aria-label="Offer deposit in cents" inputMode="numeric" placeholder="Deposit cents" value={offerDeposit} onChange={(event) => setOfferDeposit(event.target.value)} required />
              <Input aria-label="Offer expiry" type="datetime-local" value={offerExpires} onChange={(event) => setOfferExpires(event.target.value)} required />
              <Button type="submit" disabled={offer.isPending}>Create offer</Button>
            </form>
          </div>)}
          {board.data && <Button secondary onClick={() => publish.mutate()} disabled={board.data.status !== 'draft'}>Publish placements</Button>}
        </Card>
      </section>
      {notice && <p role="status" className="evaluation-notice">{notice}</p>}
    </>}
  </OrgLayout>;
}
