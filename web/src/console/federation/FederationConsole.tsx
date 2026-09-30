import { Temporal } from '@js-temporal/polyfill';
import {
  federationCapabilitiesSchema,
  type FederationCapabilities,
} from '@shared/schemas/federation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../../ui';
import { AppShell } from '../../ui/shell';

import {
  federationBootstrapResources,
  type FederationBootstrapKey,
} from './access';

import './federation.css';

type Sharing = {
  rosters?: boolean;
  compliance_status?: boolean;
  team_entries?: boolean;
  discipline?: boolean;
};
type Relationship = {
  id: string;
  parentOrgId: string;
  parentOrgName: string;
  childOrgId: string;
  childOrgName: string;
  type: string;
  initiator: 'parent' | 'child';
  status: string;
  dataSharing: Sharing;
  pendingDataSharing: Sharing | null;
  pendingSharingByMe?: boolean;
  note: string | null;
  version: number;
};
type Program = {
  programId: string;
  programName: string;
  mode: string;
  divisions: {
    divisionId: string;
    divisionName: string;
    ageLabel: string | null;
  }[];
};
type Entry = {
  id: string;
  leagueOrgId: string;
  leagueOrgName: string;
  memberOrgId: string;
  memberOrgName: string;
  programId: string;
  programName: string;
  divisionId: string;
  divisionName: string;
  externalTeamId: string;
  teamName: string;
  status: string;
  version: number;
  snapshot: { playerCount: number; status: string } | null;
};
type Member = {
  relationshipId: string;
  memberOrgId: string;
  memberOrgName: string;
  status: string;
  dataSharing: Sharing;
  teamCount: number | null;
  playerCount: number | null;
  compliancePercent: number | null;
  openDiscipline: number;
  outstandingFeeCents: number;
};
type Team = {
  teamSeasonId: string;
  displayName: string;
  programName: string;
  divisionName: string | null;
  rosterSize: number;
};
type Space = {
  spaceId: string;
  spaceName: string;
  facilityName: string | null;
  timezone: string;
};
type Referee = {
  profileId: string;
  personId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  level: string | null;
  compliant: boolean;
  active: boolean;
  assignmentCount: number;
};
type RefereeAssignment = {
  id: string;
  contestId: string;
  personId: string;
  firstName: string;
  lastName: string;
  positionKey: string;
  status: string;
  feeCents: number;
  startsAt: string;
};
type Fee = {
  id: string;
  memberOrgId: string;
  memberOrgName: string;
  description: string;
  amountCents: number;
  invoiceId: string | null;
  invoiceStatus: string | null;
  balanceCents: number | null;
  status: string;
  version: number;
};
type Contest = {
  contestId: string;
  startsAt: string;
  status: string;
  hostName: string | null;
  teams: {
    side: string;
    externalTeamId: string;
    teamName: string;
    score: number | null;
  }[];
};
type HostedGame = {
  linkId: string;
  leagueOrgId: string;
  leagueOrgName: string;
  title: string;
  startsAt: string;
  status: string;
};
type Contribution = {
  id: string;
  spaceId: string;
  spaceName: string;
  facilityName: string;
  startsAt: string;
  endsAt: string;
  status: string;
  notes: string | null;
};
type Discipline = {
  id: string;
  memberOrgId: string;
  memberOrgName: string;
  subjectType: string;
  personLabel: string | null;
  teamName: string | null;
  type: string;
  description: string;
  status: string;
  version: number;
  suspensionGames: number | null;
};
type ScheduleRun = {
  id: string;
  programId: string;
  status: string;
  draftCount: number;
  unscheduledCount: number;
  appliedAt: string | null;
};
type Overview = {
  members: {
    total: number;
    active: number;
    invited: number;
    suspended: number;
  };
  entries: Record<string, number>;
  referees: { poolSize: number; upcomingAssignments: number };
  discipline: { open: number; appealed: number };
  fees: {
    assessedCents: number;
    invoicedCents: number;
    outstandingCents: number;
    invoiceCount: number;
  };
  schedule: { linkedHostedGames: number; upcomingContests: number };
};
type ViewData = {
  relationships: Relationship[];
  programs: Program[];
  members: Member[];
  entries: Entry[];
  submissions: Entry[];
  teams: Team[];
  spaces: Space[];
  hostedGames: HostedGame[];
  contributions: Contribution[];
  referees: Referee[];
  assignments: RefereeAssignment[];
  fees: Fee[];
  payers: {
    memberOrgId: string;
    memberOrgName: string;
    billingAccountId: string;
  }[];
  discipline: Discipline[];
  memberDiscipline: Discipline[];
  scheduleRuns: ScheduleRun[];
  overview: Overview | null;
};

const unknownSchema = z.unknown();
const blankData: ViewData = {
  relationships: [],
  programs: [],
  members: [],
  entries: [],
  submissions: [],
  teams: [],
  spaces: [],
  hostedGames: [],
  contributions: [],
  referees: [],
  assignments: [],
  fees: [],
  payers: [],
  discipline: [],
  memberDiscipline: [],
  scheduleRuns: [],
  overview: null,
};
const shareLabels: { key: keyof Sharing; label: string }[] = [
  { key: 'rosters', label: 'Submitted rosters' },
  { key: 'compliance_status', label: 'Staff compliance status' },
  { key: 'team_entries', label: 'Team entry information' },
  { key: 'discipline', label: 'Federation discipline' },
];
const views = [
  'Overview',
  'Relationships',
  'Competition',
  'Operations',
] as const;
type View = (typeof views)[number];

function items<T>(value: unknown): T[] {
  if (!value || typeof value !== 'object' || !('items' in value)) return [];
  const result = (value as { items?: unknown }).items;
  return Array.isArray(result) ? (result as T[]) : [];
}
function money(cents: number | null | undefined): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
  }).format((cents ?? 0) / 100);
}
function dateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
function localInstant(value: string, timezone: string): string {
  return Temporal.PlainDateTime.from(value)
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant()
    .toString();
}
function uuidKey(): string {
  return globalThis.crypto.randomUUID();
}

async function putJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`/api/v1${path}`, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Athlentry-Request': '1',
      'Idempotency-Key': uuidKey(),
    },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value as { error?: { message?: string } } | null;
    throw new Error(
      error?.error?.message ?? 'The request could not be completed.',
    );
  }
  return value;
}

export function FederationConsole(): React.JSX.Element {
  const { orgId = '' } = useParams<{ orgId: string }>();
  const [view, setView] = useState<View>('Overview');
  const [capabilities, setCapabilities] =
    useState<FederationCapabilities | null>(null);
  const [data, setData] = useState<ViewData>(blankData);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<
    { id: string; name: string; slug: string; kind: string }[]
  >([]);
  const [direction, setDirection] = useState<'invite' | 'request'>('invite');
  const [relationshipTarget, setRelationshipTarget] = useState('');
  const [sharing, setSharing] = useState<Sharing>({});
  const [sharingRelationshipId, setSharingRelationshipId] = useState('');
  const [disciplineMemberId, setDisciplineMemberId] = useState('');
  const [disciplineSubjectType, setDisciplineSubjectType] = useState<
    'team' | 'person'
  >('team');
  const [memberOrgId, setMemberOrgId] = useState('');
  const [memberTeams, setMemberTeams] = useState<{
    teams: {
      teamSeasonId: string;
      displayName: string;
      programName: string;
      rosterSize: number;
    }[];
  } | null>(null);
  const [memberRoster, setMemberRoster] = useState<{
    teamSeasonId: string;
    players: {
      personRef: string;
      firstName: string;
      lastName: string;
      ageLabel: string | null;
      jerseyNumber: string | null;
      positions: string[];
      cardNumber: string | null;
      photoAvailable: boolean;
    }[];
  } | null>(null);
  const [remotePrograms, setRemotePrograms] = useState<Program[]>([]);
  const [leagueOrgId, setLeagueOrgId] = useState('');
  const [programId, setProgramId] = useState('');
  const [entryTeamId, setEntryTeamId] = useState('');
  const [entryDivisionId, setEntryDivisionId] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [contests, setContests] = useState<Contest[]>([]);
  const [standings, setStandings] = useState<
    {
      divisionName: string;
      rows: {
        teamId: string;
        teamName: string;
        wins: number;
        losses: number;
        ties: number;
        points: number;
      }[];
    }[]
  >([]);
  const [scheduleRuns, setScheduleRuns] = useState<ScheduleRun[]>([]);
  const [noticePhoto, setNoticePhoto] = useState<{
    personRef: string;
    mimeType: string;
    base64: string;
  } | null>(null);
  const [resultScores, setResultScores] = useState<
    Record<string, Record<string, string>>
  >({});

  const base = useMemo(
    () => `/federation/organizations/${encodeURIComponent(orgId)}`,
    [orgId],
  );
  const activeRelationships = useMemo(
    () => data.relationships.filter((item) => item.status === 'active'),
    [data.relationships],
  );
  const leagues = useMemo(
    () => activeRelationships.filter((item) => item.childOrgId === orgId),
    [activeRelationships, orgId],
  );
  const clubs = useMemo(
    () => activeRelationships.filter((item) => item.parentOrgId === orgId),
    [activeRelationships, orgId],
  );
  const relationshipOptions = useMemo(
    () =>
      activeRelationships.map((item) => ({
        value: item.id,
        label:
          item.parentOrgId === orgId ? item.childOrgName : item.parentOrgName,
      })),
    [activeRelationships, orgId],
  );
  const entryPrograms = useMemo(() => data.programs, [data.programs]);
  const selectedSpace = data.spaces.find((space) => space.spaceId === spaceId);

  const reload = useCallback(async () => {
    if (!orgId) return;
    let access: FederationCapabilities;
    try {
      access = await apiGet(
        `${base}/capabilities`,
        federationCapabilitiesSchema,
      );
      setCapabilities(access);
    } catch {
      setData(blankData);
      setCapabilities(null);
      setLoadErrors(['Federation access could not be loaded.']);
      return;
    }
    const requests = federationBootstrapResources
      .filter((resource) => access[resource.capability])
      .map((resource): [FederationBootstrapKey, string] => [
        resource.key,
        `${base}/${resource.endpoint}`,
      ]);
    const settled = await Promise.all(
      requests.map(async ([key, path]) => {
        try {
          return { key, value: await apiGet(path, unknownSchema), issue: '' };
        } catch (cause) {
          return {
            key,
            value: null,
            issue:
              cause instanceof Error
                ? cause.message
                : 'Some federation data is unavailable.',
          };
        }
      }),
    );
    const next: ViewData = { ...blankData };
    const issues: string[] = [];
    for (const result of settled) {
      if (result.issue) {
        issues.push(result.issue);
        continue;
      }
      const value = result.value;
      if (result.key === 'overview') next.overview = value as Overview;
      else if (result.key === 'relationships')
        next.relationships = items<Relationship>(value);
      else if (result.key === 'programs') next.programs = items<Program>(value);
      else if (result.key === 'members') next.members = items<Member>(value);
      else if (result.key === 'entries') next.entries = items<Entry>(value);
      else if (result.key === 'submissions')
        next.submissions = items<Entry>(value);
      else if (result.key === 'teams') next.teams = items<Team>(value);
      else if (result.key === 'spaces') next.spaces = items<Space>(value);
      else if (result.key === 'hostedGames')
        next.hostedGames = items<HostedGame>(value);
      else if (result.key === 'contributions')
        next.contributions = items<Contribution>(value);
      else if (result.key === 'referees') next.referees = items<Referee>(value);
      else if (result.key === 'assignments')
        next.assignments = items<RefereeAssignment>(value);
      else if (result.key === 'fees') next.fees = items<Fee>(value);
      else if (result.key === 'payers')
        next.payers = items<ViewData['payers'][number]>(value);
      else if (result.key === 'discipline')
        next.discipline = items<Discipline>(value);
      else if (result.key === 'memberDiscipline')
        next.memberDiscipline = items<Discipline>(value);
      else next.scheduleRuns = items<ScheduleRun>(value);
    }
    setData(next);
    setLoadErrors([...new Set(issues)]);
  }, [base, orgId]);

  const visibleViews = useMemo(() => {
    if (!capabilities) return ['Overview'] as View[];
    return views.filter((item) => {
      if (item === 'Overview') return capabilities.directory;
      if (item === 'Relationships') return capabilities.relationships;
      if (item === 'Competition')
        return (
          capabilities.directory ||
          capabilities.submitEntries ||
          capabilities.schedule
        );
      return (
        capabilities.submitEntries ||
        capabilities.schedule ||
        capabilities.discipline ||
        capabilities.referees ||
        capabilities.finance
      );
    });
  }, [capabilities]);

  useEffect(() => {
    if (!visibleViews.includes(view) && visibleViews[0])
      setView(visibleViews[0]);
  }, [view, visibleViews]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mutate = useCallback(
    async (success: string, action: () => Promise<unknown>) => {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        await action();
        setNotice(success);
        await reload();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'The request could not be completed.',
        );
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const post = useCallback(
    (path: string, body: unknown = {}) =>
      apiPost(`${base}${path}`, body, unknownSchema, uuidKey()),
    [base],
  );

  async function searchOrganizations(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setError('');
    setMatches([]);
    setRelationshipTarget('');
    try {
      const result = (await apiGet(
        `${base}/relationships/lookup?q=${encodeURIComponent(search)}`,
        unknownSchema,
      )) as {
        items?: { id: string; name: string; slug: string; kind: string }[];
      };
      setMatches(result.items ?? []);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Organization search failed.',
      );
    }
  }

  async function loadLeaguePrograms(id: string): Promise<void> {
    setLeagueOrgId(id);
    setRemotePrograms([]);
    setProgramId('');
    if (!id) return;
    try {
      const result = (await apiGet(
        `${base}/league-programs?leagueOrgId=${encodeURIComponent(id)}`,
        unknownSchema,
      )) as { programs?: Program[] };
      setRemotePrograms(result.programs ?? []);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'League programs could not be loaded.',
      );
    }
  }

  async function loadCompetition(
    program: string,
    league = false,
  ): Promise<void> {
    setProgramId(program);
    setContests([]);
    setStandings([]);
    setScheduleRuns([]);
    if (!program) return;
    try {
      const contestsPath = league
        ? `${base}/programs/${program}/contests`
        : `${base}/member-standings?leagueOrgId=${encodeURIComponent(leagueOrgId)}&programId=${encodeURIComponent(program)}`;
      const [contestsValue, standingsValue, runsValue] = await Promise.all([
        league ? apiGet(contestsPath, unknownSchema) : Promise.resolve(null),
        apiGet(
          league ? `${base}/programs/${program}/standings` : contestsPath,
          unknownSchema,
        ),
        league && capabilities?.schedule
          ? apiGet(
              `${base}/schedule-runs?programId=${encodeURIComponent(program)}`,
              unknownSchema,
            )
          : Promise.resolve(null),
      ]);
      if (league) setContests(items<Contest>(contestsValue));
      setStandings(
        (standingsValue as { divisions?: typeof standings }).divisions ?? [],
      );
      setScheduleRuns(items<ScheduleRun>(runsValue));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Competition data could not be loaded.',
      );
    }
  }

  async function openMember(member: Member): Promise<void> {
    setSelectedMember(member);
    setMemberOrgId(member.memberOrgId);
    setMemberTeams(null);
    setMemberRoster(null);
    setNoticePhoto(null);
    try {
      setMemberTeams(
        (await apiGet(
          `${base}/members/${member.memberOrgId}/teams`,
          unknownSchema,
        )) as typeof memberTeams,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Member teams could not be loaded.',
      );
    }
  }

  async function openRoster(teamSeasonId: string): Promise<void> {
    setMemberRoster(null);
    try {
      setMemberRoster(
        (await apiGet(
          `${base}/members/${memberOrgId}/roster?teamSeasonId=${encodeURIComponent(teamSeasonId)}`,
          unknownSchema,
        )) as typeof memberRoster,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Roster unavailable.');
    }
  }

  async function loadStandingsForHost(
    league: string,
    program: string,
  ): Promise<void> {
    setLeagueOrgId(league);
    setProgramId(program);
    setStandings([]);
    if (!league || !program) return;
    try {
      const result = (await apiGet(
        `${base}/member-standings?leagueOrgId=${encodeURIComponent(league)}&programId=${encodeURIComponent(program)}`,
        unknownSchema,
      )) as { divisions?: typeof standings };
      setStandings(result.divisions ?? []);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Standings could not be loaded.',
      );
    }
  }

  if (!orgId) return <main>Organization not found.</main>;
  const activeClubList = data.members;

  return (
    <AppShell
      orgName="Federation"
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Organization home', to: `/console/orgs/${orgId}` },
            {
              label: 'Federation',
              to: `/console/federation/${orgId}`,
              current: true,
            },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        {
          label: 'Federation',
          to: `/console/federation/${orgId}`,
          current: true,
        },
        { label: 'Account', to: '/me' },
      ]}
    >
      <main className="console-home federation-console">
        <PageHeader
          kicker="FEDERATION"
          title="League and association"
          description="Manage member relationships, team entries, shared schedules, officials, discipline and club invoices."
        />
        {notice && (
          <p className="federation-notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="federation-error" role="alert">
            {error}
          </p>
        )}
        {loadErrors.length > 0 && (
          <details className="federation-access">
            <summary>Some panels are unavailable to your role</summary>
            <ul>
              {loadErrors.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>
        )}
        {capabilities && !visibleViews.length ? (
          <p className="federation-notice" role="status">
            Federation tools are not available to your organization role.
          </p>
        ) : (
          <nav className="federation-tabs" aria-label="Federation sections">
            {visibleViews.map((item) => (
              <Button
                key={item}
                type="button"
                secondary={view !== item}
                aria-current={view === item ? 'page' : undefined}
                onClick={() => {
                  setView(item);
                }}
              >
                {item}
              </Button>
            ))}
          </nav>
        )}

        {view === 'Overview' && (
          <>
            <section
              className="federation-metrics"
              aria-label="Federation summary"
            >
              <Metric
                label="Member clubs"
                value={
                  data.overview?.members.active ??
                  activeClubList.filter((item) => item.status === 'active')
                    .length
                }
                detail={`${String(data.overview?.members.invited ?? 0)} invitations pending`}
              />
              <Metric
                label="Accepted teams"
                value={
                  data.overview?.entries.accepted ??
                  activeClubList.reduce(
                    (sum, item) => sum + (item.teamCount ?? 0),
                    0,
                  )
                }
                detail={`${String(data.overview?.entries.pending_approval ?? 0)} awaiting review`}
              />
              <Metric
                label="Players shared"
                value={activeClubList.reduce(
                  (sum, item) => sum + (item.playerCount ?? 0),
                  0,
                )}
                detail="Submitted roster snapshots"
              />
              <Metric
                label="Fees outstanding"
                value={money(data.overview?.fees.outstandingCents)}
                detail={`${String(data.overview?.fees.invoiceCount ?? 0)} league invoices`}
              />
            </section>
            <Card>
              <h2>Member clubs</h2>
              {activeClubList.length === 0 ? (
                <p>
                  No member clubs are connected yet. Invite an organization in
                  Relationships.
                </p>
              ) : (
                <div className="federation-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Organization</th>
                        <th scope="col">Teams</th>
                        <th scope="col">Players</th>
                        <th scope="col">Compliance</th>
                        <th scope="col">Open discipline</th>
                        <th scope="col">Outstanding fees</th>
                        <th scope="col">Roster access</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeClubList.map((member) => (
                        <tr key={member.memberOrgId}>
                          <th scope="row">
                            <Button
                              secondary
                              type="button"
                              onClick={() => void openMember(member)}
                            >
                              {member.memberOrgName}
                            </Button>
                          </th>
                          <td>{member.teamCount ?? '—'}</td>
                          <td>{member.playerCount ?? '—'}</td>
                          <td>
                            {member.compliancePercent === null
                              ? 'Not shared'
                              : `${String(member.compliancePercent)}% cleared`}
                          </td>
                          <td>{member.openDiscipline}</td>
                          <td>{money(member.outstandingFeeCents)}</td>
                          <td>
                            {member.dataSharing.rosters
                              ? 'Shared'
                              : 'Not shared'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            {memberOrgId && (
              <Card className="federation-member-detail">
                <div className="federation-card-heading">
                  <h2>
                    {selectedMember?.memberOrgName ?? 'Member club'} teams
                  </h2>
                  <Button
                    secondary
                    type="button"
                    onClick={() => {
                      setMemberOrgId('');
                      setSelectedMember(null);
                      setMemberTeams(null);
                      setMemberRoster(null);
                    }}
                  >
                    Close
                  </Button>
                </div>
                {memberTeams && (
                  <ul className="federation-list">
                    {memberTeams.teams.map((team) => (
                      <li key={team.teamSeasonId}>
                        <span>
                          <strong>{team.displayName}</strong>
                          <small>
                            {team.programName} · {team.rosterSize} rostered
                            players
                          </small>
                        </span>
                        {selectedMember?.dataSharing.rosters && (
                          <Button
                            type="button"
                            secondary
                            onClick={() => void openRoster(team.teamSeasonId)}
                          >
                            View submitted roster
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {memberRoster && (
                  <div className="federation-roster">
                    <h3>Submitted roster</h3>
                    <p>
                      These rows come from the club’s saved submission. Current
                      photo consent is checked again before an image is shown.
                    </p>
                    <ul className="federation-list">
                      {memberRoster.players.map((player) => (
                        <li key={player.personRef}>
                          <span>
                            <strong>
                              {player.firstName} {player.lastName}
                            </strong>
                            <small>
                              {[
                                player.ageLabel,
                                player.jerseyNumber
                                  ? `#${player.jerseyNumber}`
                                  : null,
                                player.positions.join(', '),
                                player.cardNumber
                                  ? `Card ${player.cardNumber}`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </small>
                            {noticePhoto?.personRef === player.personRef && (
                              <img
                                className="federation-player-photo"
                                alt={`${player.firstName} ${player.lastName}`}
                                src={`data:${noticePhoto.mimeType};base64,${noticePhoto.base64}`}
                              />
                            )}
                          </span>
                          {player.photoAvailable && (
                            <Button
                              secondary
                              type="button"
                              onClick={() =>
                                void apiGet(
                                  `${base}/members/${memberOrgId}/roster/${memberRoster.teamSeasonId}/photos/${player.personRef}`,
                                  unknownSchema,
                                )
                                  .then((photo) => {
                                    const image = photo as {
                                      mimeType: string;
                                      base64: string;
                                    };
                                    setNoticePhoto({
                                      personRef: player.personRef,
                                      mimeType: image.mimeType,
                                      base64: image.base64,
                                    });
                                  })
                                  .catch((cause: unknown) => {
                                    setError(
                                      cause instanceof Error
                                        ? cause.message
                                        : 'Photo unavailable.',
                                    );
                                  })
                              }
                            >
                              View consented photo
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
            )}
            <Card>
              <h2>League activity</h2>
              <div className="federation-summary-grid">
                <p>
                  <strong>
                    {data.overview?.schedule.upcomingContests ?? 0}
                  </strong>
                  <span> upcoming contests</span>
                </p>
                <p>
                  <strong>
                    {data.overview?.referees.poolSize ?? data.referees.length}
                  </strong>
                  <span> active referees</span>
                </p>
                <p>
                  <strong>{data.overview?.discipline.open ?? 0}</strong>
                  <span> open discipline cases</span>
                </p>
                <p>
                  <strong>
                    {data.overview?.fees.assessedCents
                      ? money(data.overview.fees.assessedCents)
                      : money(0)}
                  </strong>
                  <span> assessed fees</span>
                </p>
              </div>
            </Card>
          </>
        )}

        {view === 'Relationships' && (
          <>
            <Card>
              <h2>Find an organization</h2>
              <form
                className="federation-form"
                onSubmit={(event) => void searchOrganizations(event)}
              >
                <Field label="Name, organization slug, or owner email">
                  <Input
                    minLength={2}
                    maxLength={100}
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                    }}
                    required
                  />
                </Field>
                <Button type="submit" disabled={busy}>
                  Search
                </Button>
              </form>
              {matches.length > 0 && (
                <ul className="federation-list">
                  {matches.map((match) => (
                    <li key={match.id}>
                      <span>
                        <strong>{match.name}</strong>
                        <small>
                          {match.slug} · {match.kind}
                        </small>
                      </span>
                      <Button
                        secondary
                        type="button"
                        onClick={() => {
                          setRelationshipTarget(match.id);
                        }}
                      >
                        Select
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="federation-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!relationshipTarget) return;
                  void mutate('Relationship request sent.', () =>
                    post('/relationships', {
                      direction,
                      organizationId: relationshipTarget,
                      type: 'member_club',
                      dataSharing: sharing,
                    }),
                  );
                }}
              >
                <Field label="Relationship direction">
                  <Select
                    value={direction}
                    onChange={(event) => {
                      setDirection(event.target.value as 'invite' | 'request');
                    }}
                    options={[
                      {
                        value: 'invite',
                        label: 'Invite this organization as a member club',
                      },
                      {
                        value: 'request',
                        label: 'Request to join this organization',
                      },
                    ]}
                  />
                </Field>
                <Field label="Selected organization">
                  <Select
                    value={relationshipTarget}
                    onChange={(event) => {
                      setRelationshipTarget(event.target.value);
                    }}
                    options={[
                      { value: '', label: 'Choose a search result' },
                      ...matches.map((match) => ({
                        value: match.id,
                        label: `${match.name} (${match.slug})`,
                      })),
                    ]}
                  />
                </Field>
                <SharingFields
                  value={sharing}
                  onChange={setSharing}
                  label="Proposed data-sharing agreement"
                />
                <Button type="submit" disabled={busy || !relationshipTarget}>
                  Send relationship request
                </Button>
              </form>
            </Card>
            <Card>
              <h2>Relationships and agreements</h2>
              {data.relationships.length === 0 ? (
                <p>No invitations or federation agreements yet.</p>
              ) : (
                <ul className="federation-list">
                  {data.relationships.map((relationship) => (
                    <li
                      className="federation-relationship"
                      key={relationship.id}
                    >
                      <span>
                        <strong>
                          {relationship.parentOrgName} ·{' '}
                          {relationship.childOrgName}
                        </strong>
                        <small>
                          <Badge>{relationship.status}</Badge>{' '}
                          {relationship.type} · Shares:{' '}
                          {shareLabels
                            .filter(({ key }) => relationship.dataSharing[key])
                            .map(({ label }) => label)
                            .join(', ') || 'none'}
                        </small>
                        {relationship.pendingDataSharing && (
                          <small>
                            Sharing change awaits the other organization:{' '}
                            {shareLabels
                              .filter(
                                ({ key }) =>
                                  relationship.pendingDataSharing?.[key],
                              )
                              .map(({ label }) => label)
                              .join(', ') || 'none'}
                          </small>
                        )}
                      </span>
                      <div className="federation-actions">
                        {relationship.status === 'invited' &&
                          ((relationship.initiator === 'parent' &&
                            relationship.childOrgId === orgId) ||
                            (relationship.initiator === 'child' &&
                              relationship.parentOrgId === orgId)) && (
                            <>
                              <Button
                                type="button"
                                onClick={() =>
                                  void mutate('Invitation accepted.', () =>
                                    post(
                                      `/relationships/${relationship.id}/accept`,
                                    ),
                                  )
                                }
                              >
                                Accept
                              </Button>
                              <Button
                                secondary
                                type="button"
                                onClick={() =>
                                  void mutate('Invitation declined.', () =>
                                    post(
                                      `/relationships/${relationship.id}/decline`,
                                    ),
                                  )
                                }
                              >
                                Decline
                              </Button>
                            </>
                          )}
                        {relationship.pendingDataSharing &&
                          !relationship.pendingSharingByMe && (
                            <>
                              <Button
                                type="button"
                                onClick={() =>
                                  void mutate(
                                    'Sharing agreement updated.',
                                    () =>
                                      post(
                                        `/relationships/${relationship.id}/sharing/accept`,
                                        { version: relationship.version },
                                      ),
                                  )
                                }
                              >
                                Accept sharing change
                              </Button>
                              <Button
                                secondary
                                type="button"
                                onClick={() =>
                                  void mutate(
                                    'Sharing proposal declined.',
                                    () =>
                                      post(
                                        `/relationships/${relationship.id}/sharing/decline`,
                                        { version: relationship.version },
                                      ),
                                  )
                                }
                              >
                                Decline sharing change
                              </Button>
                            </>
                          )}
                        {relationship.status === 'active' &&
                          relationship.parentOrgId === orgId && (
                            <Button
                              secondary
                              type="button"
                              onClick={() =>
                                void mutate('Relationship suspended.', () =>
                                  post(
                                    `/relationships/${relationship.id}/suspend`,
                                    { version: relationship.version },
                                  ),
                                )
                              }
                            >
                              Suspend
                            </Button>
                          )}
                        {relationship.status === 'suspended' &&
                          relationship.parentOrgId === orgId && (
                            <Button
                              type="button"
                              onClick={() =>
                                void mutate('Relationship resumed.', () =>
                                  post(
                                    `/relationships/${relationship.id}/resume`,
                                    { version: relationship.version },
                                  ),
                                )
                              }
                            >
                              Resume
                            </Button>
                          )}
                        {['active', 'suspended'].includes(
                          relationship.status,
                        ) && (
                          <Button
                            secondary
                            type="button"
                            onClick={() => {
                              if (
                                window.confirm(
                                  'End this federation relationship now? Shared data access stops immediately.',
                                )
                              )
                                void mutate(
                                  'Relationship ended. Shared data access has stopped.',
                                  () =>
                                    post(
                                      `/relationships/${relationship.id}/end`,
                                      { version: relationship.version },
                                    ),
                                );
                            }}
                          >
                            End relationship
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h2>Propose a sharing update</h2>
              <form
                className="federation-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const target = data.relationships.find(
                    (item) => item.id === sharingRelationshipId,
                  );
                  if (!target) return;
                  void mutate('Sharing proposal sent.', () =>
                    post(`/relationships/${target.id}/sharing`, {
                      dataSharing: sharing,
                      version: target.version,
                    }),
                  );
                }}
              >
                <Field label="Active agreement">
                  <Select
                    value={sharingRelationshipId}
                    onChange={(event) => {
                      setSharingRelationshipId(event.target.value);
                    }}
                    options={[
                      { value: '', label: 'Choose a relationship' },
                      ...data.relationships
                        .filter((item) => item.status === 'active')
                        .map((item) => ({
                          value: item.id,
                          label: `${item.parentOrgName} · ${item.childOrgName}`,
                        })),
                    ]}
                  />
                </Field>
                <SharingFields
                  value={sharing}
                  onChange={setSharing}
                  label="Datasets requested"
                />
                <Button type="submit" disabled={busy || !sharingRelationshipId}>
                  Propose agreement
                </Button>
              </form>
            </Card>
          </>
        )}

        {view === 'Competition' && (
          <>
            <Card>
              <h2>Team entries</h2>
              {leagues.length > 0 && (
                <>
                  <p>
                    Submit one of your club’s team seasons into an active league
                    program.
                  </p>
                  <div className="federation-form">
                    <Field label="League">
                      <Select
                        value={leagueOrgId}
                        onChange={(event) =>
                          void loadLeaguePrograms(event.target.value)
                        }
                        options={[
                          { value: '', label: 'Choose a league' },
                          ...leagues.map((item) => ({
                            value: item.parentOrgId,
                            label: item.parentOrgName,
                          })),
                        ]}
                      />
                    </Field>
                    <Field label="Team season">
                      <Select
                        value={entryTeamId}
                        onChange={(event) => {
                          setEntryTeamId(event.target.value);
                          setEntryDivisionId('');
                        }}
                        options={[
                          { value: '', label: 'Choose a team' },
                          ...data.teams.map((team) => ({
                            value: team.teamSeasonId,
                            label: `${team.displayName} · ${team.programName}`,
                          })),
                        ]}
                      />
                    </Field>
                    <Field label="League program">
                      <Select
                        value={programId}
                        onChange={(event) => {
                          setProgramId(event.target.value);
                          setEntryDivisionId('');
                        }}
                        options={[
                          { value: '', label: 'Choose a program' },
                          ...remotePrograms.map((program) => ({
                            value: program.programId,
                            label: program.programName,
                          })),
                        ]}
                      />
                    </Field>
                    <Field label="Division">
                      <Select
                        value={entryDivisionId}
                        onChange={(event) => {
                          setEntryDivisionId(event.target.value);
                        }}
                        options={[
                          { value: '', label: 'Choose a division' },
                          ...(
                            remotePrograms.find(
                              (program) => program.programId === programId,
                            )?.divisions ?? []
                          ).map((division) => ({
                            value: division.divisionId,
                            label: `${division.divisionName}${division.ageLabel ? ` · ${division.ageLabel}` : ''}`,
                          })),
                        ]}
                      />
                    </Field>
                    <Button
                      type="button"
                      disabled={
                        busy ||
                        !leagueOrgId ||
                        !programId ||
                        !entryTeamId ||
                        !entryDivisionId
                      }
                      onClick={() => {
                        void mutate(
                          'Team entry submitted with a roster snapshot.',
                          () =>
                            post('/submitted-entries', {
                              leagueOrgId,
                              programId,
                              divisionId: entryDivisionId,
                              teamSeasonId: entryTeamId,
                            }),
                        );
                      }}
                    >
                      Submit team
                    </Button>
                  </div>
                </>
              )}
              {data.submissions.length > 0 && (
                <>
                  <h3>Your submitted entries</h3>
                  <ul className="federation-list">
                    {data.submissions.map((entry) => (
                      <li key={entry.id}>
                        <span>
                          <strong>{entry.teamName}</strong>
                          <small>
                            {entry.leagueOrgName} · {entry.programName} ·{' '}
                            {entry.status} · {entry.snapshot?.playerCount ?? 0}{' '}
                            snapshot players
                          </small>
                        </span>
                        {[
                          'pending_approval',
                          'accepted',
                          'waitlisted',
                        ].includes(entry.status) && (
                          <Button
                            secondary
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void mutate('Roster snapshot resubmitted.', () =>
                                post(`/submitted-entries/${entry.id}/roster`, {
                                  leagueOrgId: entry.leagueOrgId,
                                }),
                              )
                            }
                          >
                            Resubmit roster
                          </Button>
                        )}
                        {[
                          'pending_approval',
                          'accepted',
                          'waitlisted',
                        ].includes(entry.status) && (
                          <Button
                            secondary
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void mutate('Team entry withdrawn.', () =>
                                post(
                                  `/submitted-entries/${entry.id}/withdraw`,
                                  { leagueOrgId: entry.leagueOrgId },
                                ),
                              )
                            }
                          >
                            Withdraw
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {clubs.length > 0 && (
                <>
                  <h3>League entries to review</h3>
                  <EntryList
                    entries={data.entries}
                    busy={busy}
                    onReview={(entry, action) =>
                      void mutate(
                        `Entry ${action === 'accept' ? 'accepted' : action === 'waitlist' ? 'waitlisted' : 'declined'}.`,
                        () =>
                          post(`/entries/${entry.id}/review`, {
                            action,
                            version: entry.version,
                          }),
                      )
                    }
                  />
                  <div className="federation-form">
                    <Field label="Set roster window for a league program">
                      <Select
                        value={programId}
                        onChange={(event) => {
                          setProgramId(event.target.value);
                        }}
                        options={[
                          { value: '', label: 'Choose a program' },
                          ...entryPrograms.map((program) => ({
                            value: program.programId,
                            label: program.programName,
                          })),
                        ]}
                      />
                    </Field>
                    <Field label="Submission deadline">
                      <Input type="datetime-local" id="federation-submit-by" />
                    </Field>
                    <Field label="Freeze at (optional)">
                      <Input type="datetime-local" id="federation-freeze-at" />
                    </Field>
                    <Button
                      type="button"
                      disabled={busy || !programId}
                      onClick={() => {
                        const submitBy = (
                          document.getElementById(
                            'federation-submit-by',
                          ) as HTMLInputElement | null
                        )?.value;
                        const freezeAt = (
                          document.getElementById(
                            'federation-freeze-at',
                          ) as HTMLInputElement | null
                        )?.value;
                        if (!submitBy) {
                          setError('Choose a roster submission deadline.');
                          return;
                        }
                        void mutate('Roster window saved.', () =>
                          putJson(
                            `${base}/programs/${programId}/roster-window`,
                            {
                              submitBy: new Date(submitBy).toISOString(),
                              freezeAt: freezeAt
                                ? new Date(freezeAt).toISOString()
                                : null,
                            },
                          ),
                        );
                      }}
                    >
                      Save roster window
                    </Button>
                    <Button
                      secondary
                      type="button"
                      disabled={busy || !programId}
                      onClick={() =>
                        void mutate('Roster snapshots frozen.', () =>
                          post(`/programs/${programId}/roster-freeze`),
                        )
                      }
                    >
                      Freeze submitted rosters
                    </Button>
                  </div>
                </>
              )}
            </Card>
            <Card>
              <h2>Availability and league schedule</h2>
              {leagues.length > 0 && (
                <div className="federation-form">
                  <Field label="Offer field windows to a league">
                    <Select
                      value={sharingRelationshipId}
                      onChange={(event) => {
                        setSharingRelationshipId(event.target.value);
                      }}
                      options={[
                        { value: '', label: 'Choose a league relationship' },
                        ...leagues.map((item) => ({
                          value: item.id,
                          label: item.parentOrgName,
                        })),
                      ]}
                    />
                  </Field>
                  <Field label="Field or court">
                    <Select
                      value={spaceId}
                      onChange={(event) => {
                        setSpaceId(event.target.value);
                      }}
                      options={[
                        { value: '', label: 'Choose a space' },
                        ...data.spaces.map((space) => ({
                          value: space.spaceId,
                          label: `${space.spaceName} · ${space.facilityName ?? 'Facility'}`,
                        })),
                      ]}
                    />
                  </Field>
                  <p className="federation-form__hint">
                    {selectedSpace
                      ? `Availability times use ${selectedSpace.timezone}.`
                      : 'Choose a space to see its timezone.'}
                  </p>
                  <Field label="Available from">
                    <Input type="datetime-local" id="federation-window-start" />
                  </Field>
                  <Field label="Available until">
                    <Input type="datetime-local" id="federation-window-end" />
                  </Field>
                  <Field label="Notes">
                    <Input id="federation-window-notes" maxLength={1000} />
                  </Field>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const startsAt = (
                        document.getElementById(
                          'federation-window-start',
                        ) as HTMLInputElement | null
                      )?.value;
                      const endsAt = (
                        document.getElementById(
                          'federation-window-end',
                        ) as HTMLInputElement | null
                      )?.value;
                      if (
                        !startsAt ||
                        !endsAt ||
                        !selectedSpace ||
                        !sharingRelationshipId
                      ) {
                        setError(
                          'Choose a league, space and complete availability window.',
                        );
                        return;
                      }
                      let startsAtInstant: string;
                      let endsAtInstant: string;
                      try {
                        startsAtInstant = localInstant(
                          startsAt,
                          selectedSpace.timezone,
                        );
                        endsAtInstant = localInstant(
                          endsAt,
                          selectedSpace.timezone,
                        );
                      } catch {
                        setError('Enter a valid availability window.');
                        return;
                      }
                      if (
                        Date.parse(startsAtInstant) >= Date.parse(endsAtInstant)
                      ) {
                        setError('The availability end must follow its start.');
                        return;
                      }
                      void mutate('Availability offered to the league.', () =>
                        post('/space-contributions', {
                          relationshipId: sharingRelationshipId,
                          spaceId,
                          windows: [
                            {
                              startsAt: startsAtInstant,
                              endsAt: endsAtInstant,
                            },
                          ],
                          notes:
                            (
                              document.getElementById(
                                'federation-window-notes',
                              ) as HTMLInputElement | null
                            )?.value || undefined,
                        }),
                      );
                    }}
                  >
                    Offer availability
                  </Button>
                </div>
              )}
              {clubs.length > 0 && (
                <div className="federation-form">
                  <Field label="League program">
                    <Select
                      value={programId}
                      onChange={(event) =>
                        void loadCompetition(event.target.value, true)
                      }
                      options={[
                        { value: '', label: 'Choose a program' },
                        ...entryPrograms.map((program) => ({
                          value: program.programId,
                          label: program.programName,
                        })),
                      ]}
                    />
                  </Field>
                  <Field label="Earliest date">
                    <Input
                      type="date"
                      id="federation-earliest"
                      defaultValue="2026-10-01"
                    />
                  </Field>
                  <Field label="Latest date">
                    <Input
                      type="date"
                      id="federation-latest"
                      defaultValue="2026-11-30"
                    />
                  </Field>
                  <Field label="Game length (minutes)">
                    <Input
                      type="number"
                      min={15}
                      max={300}
                      id="federation-game-minutes"
                      defaultValue={60}
                    />
                  </Field>
                  <Button
                    type="button"
                    disabled={busy || !programId}
                    onClick={() => {
                      const earliestDate = (
                        document.getElementById(
                          'federation-earliest',
                        ) as HTMLInputElement | null
                      )?.value;
                      const latestDate = (
                        document.getElementById(
                          'federation-latest',
                        ) as HTMLInputElement | null
                      )?.value;
                      const gameMinutes = Number(
                        (
                          document.getElementById(
                            'federation-game-minutes',
                          ) as HTMLInputElement | null
                        )?.value ?? 60,
                      );
                      void mutate(
                        'Schedule draft generated from league and member-club availability.',
                        async () => {
                          const result = (await post('/schedule-runs', {
                            programId,
                            rounds: 1,
                            earliestDate,
                            latestDate,
                            gameMinutes,
                            bufferMinutes: 10,
                            timeWindows: [1, 2, 3, 4, 5, 6, 7].map(
                              (weekday) => ({
                                weekday,
                                startMinute: 480,
                                endMinute: 1200,
                              }),
                            ),
                          })) as { run?: ScheduleRun };
                          if (result.run)
                            setScheduleRuns((previous) => [
                              result.run as ScheduleRun,
                              ...previous,
                            ]);
                        },
                      );
                    }}
                  >
                    Generate schedule draft
                  </Button>
                </div>
              )}
              {leagues.length > 0 && (
                <p>
                  Contributed windows:{' '}
                  {data.contributions.length
                    ? data.contributions
                        .map((item) => `${item.spaceName} (${item.status})`)
                        .join(', ')
                    : 'none yet'}
                </p>
              )}
              {clubs.length > 0 && (
                <>
                  <h3>Schedule runs</h3>
                  {scheduleRuns.length === 0 ? (
                    <p>Choose a league program to load its runs.</p>
                  ) : (
                    <ul className="federation-list">
                      {scheduleRuns.map((run) => (
                        <li key={run.id}>
                          <span>
                            <strong>{run.status}</strong>
                            <small>
                              {run.draftCount} games · {run.unscheduledCount}{' '}
                              unscheduled
                            </small>
                          </span>
                          {run.status === 'succeeded' && (
                            <Button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void mutate(
                                  'Schedule applied to league and home-club calendars.',
                                  async () => {
                                    await post(
                                      `/schedule-runs/${run.id}/apply`,
                                    );
                                    setScheduleRuns((current) =>
                                      current.map((item) =>
                                        item.id === run.id
                                          ? { ...item, status: 'applied' }
                                          : item,
                                      ),
                                    );
                                  },
                                )
                              }
                            >
                              Apply schedule
                            </Button>
                          )}
                          {run.status === 'applied' && (
                            <Button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void mutate('Schedule published.', () =>
                                  post(`/schedule-runs/${run.id}/publish`).then(
                                    () => {
                                      setScheduleRuns((current) =>
                                        current.map((item) =>
                                          item.id === run.id
                                            ? { ...item, status: 'published' }
                                            : item,
                                        ),
                                      );
                                    },
                                  ),
                                )
                              }
                            >
                              Publish schedule
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {leagues.length > 0 && data.contributions.length > 0 && (
                <ul className="federation-list">
                  {data.contributions.map((item) => (
                    <li key={item.id}>
                      <span>
                        <strong>{item.spaceName}</strong>
                        <small>
                          {dateTime(item.startsAt)} – {dateTime(item.endsAt)} ·{' '}
                          {item.status}
                        </small>
                      </span>
                      {item.status === 'offered' && (
                        <Button
                          secondary
                          type="button"
                          onClick={() =>
                            void mutate('Availability offer withdrawn.', () =>
                              post(`/space-contributions/${item.id}/withdraw`),
                            )
                          }
                        >
                          Withdraw
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h2>Results and standings</h2>
              {clubs.length > 0 && (
                <Field label="League program">
                  <Select
                    value={programId}
                    onChange={(event) =>
                      void loadCompetition(event.target.value, true)
                    }
                    options={[
                      { value: '', label: 'Choose a program' },
                      ...entryPrograms.map((program) => ({
                        value: program.programId,
                        label: program.programName,
                      })),
                    ]}
                  />
                </Field>
              )}
              {leagues.length > 0 && (
                <>
                  <Field label="League">
                    <Select
                      value={leagueOrgId}
                      onChange={(event) => {
                        setLeagueOrgId(event.target.value);
                      }}
                      options={[
                        { value: '', label: 'Choose a league' },
                        ...leagues.map((item) => ({
                          value: item.parentOrgId,
                          label: item.parentOrgName,
                        })),
                      ]}
                    />
                  </Field>
                  <Field label="Your league program">
                    <Select
                      value={programId}
                      onChange={(event) =>
                        void loadStandingsForHost(
                          leagueOrgId,
                          event.target.value,
                        )
                      }
                      options={[
                        { value: '', label: 'Choose a program' },
                        ...data.submissions.map((item) => ({
                          value: item.programId,
                          label: item.programName,
                        })),
                      ]}
                    />
                  </Field>
                </>
              )}
              {contests.length > 0 && (
                <div className="federation-list">
                  {contests.map((contest) => (
                    <div className="federation-contest" key={contest.contestId}>
                      <strong>
                        {dateTime(contest.startsAt)} ·{' '}
                        {contest.hostName ?? 'Host pending'}
                      </strong>
                      <ul>
                        {contest.teams.map((team) => (
                          <li key={team.externalTeamId}>
                            {team.teamName}: {team.score ?? '—'}
                          </li>
                        ))}
                      </ul>
                      {contest.teams.length > 1 && (
                        <div className="federation-actions">
                          {contest.teams.map((team) => (
                            <Field
                              key={team.externalTeamId}
                              label={`${team.teamName} score`}
                            >
                              <Input
                                type="number"
                                min={0}
                                max={10000}
                                value={
                                  resultScores[contest.contestId]?.[
                                    team.externalTeamId
                                  ] ??
                                  team.score ??
                                  ''
                                }
                                onChange={(event) => {
                                  setResultScores((prior) => ({
                                    ...prior,
                                    [contest.contestId]: {
                                      ...prior[contest.contestId],
                                      [team.externalTeamId]: event.target.value,
                                    },
                                  }));
                                }}
                              />
                            </Field>
                          ))}
                          <Button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void mutate('Contest result recorded.', () =>
                                post(`/contests/${contest.contestId}/result`, {
                                  results: contest.teams.map((team) => ({
                                    externalTeamId: team.externalTeamId,
                                    score: Number(
                                      resultScores[contest.contestId]?.[
                                        team.externalTeamId
                                      ] ??
                                        team.score ??
                                        0,
                                    ),
                                  })),
                                  finalize: true,
                                }),
                              )
                            }
                          >
                            Save result
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {standings.map((division) => (
                <section key={division.divisionName}>
                  <h3>{division.divisionName} standings</h3>
                  <div className="federation-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Team</th>
                          <th scope="col">W</th>
                          <th scope="col">L</th>
                          <th scope="col">T</th>
                          <th scope="col">Points</th>
                        </tr>
                      </thead>
                      <tbody>
                        {division.rows.map((row) => (
                          <tr key={row.teamId}>
                            <th scope="row">{row.teamName}</th>
                            <td>{row.wins}</td>
                            <td>{row.losses}</td>
                            <td>{row.ties}</td>
                            <td>{row.points}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
              {data.hostedGames.length > 0 && (
                <>
                  <h3>Games hosted by this club</h3>
                  <ul className="federation-list">
                    {data.hostedGames.map((game) => (
                      <li key={game.linkId}>
                        <span>
                          <strong>{game.title}</strong>
                          <small>
                            {game.leagueOrgName} · {dateTime(game.startsAt)} ·{' '}
                            {game.status}
                          </small>
                        </span>
                        <HostedResultButton
                          disabled={busy}
                          game={game}
                          teams={standings.flatMap((division) => division.rows)}
                          onSave={(body) =>
                            void mutate(
                              'Hosted game result submitted to the league.',
                              () =>
                                post(
                                  `/hosted-games/${game.linkId}/result`,
                                  body,
                                ),
                            )
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
          </>
        )}

        {view === 'Operations' && (
          <>
            <Card>
              <h2>League referee pool</h2>
              {clubs.length > 0 && (
                <form
                  className="federation-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void mutate('Referee added to the league pool.', () =>
                      post('/referees', {
                        personId: form.get('personId'),
                        grade: form.get('grade') || undefined,
                        level: form.get('level') || undefined,
                      }),
                    );
                  }}
                >
                  <Field label="Person ID">
                    <Input
                      name="personId"
                      required
                      pattern="[0-9a-fA-F-]{36}"
                    />
                  </Field>
                  <Field label="Grade">
                    <Input name="grade" maxLength={50} />
                  </Field>
                  <Field label="Level">
                    <Input name="level" maxLength={50} />
                  </Field>
                  <Button type="submit" disabled={busy}>
                    Add referee
                  </Button>
                </form>
              )}
              {data.referees.length === 0 ? (
                <p>No officials are in this organization’s referee pool.</p>
              ) : (
                <ul className="federation-list">
                  {data.referees.map((referee) => (
                    <li key={referee.profileId}>
                      <span>
                        <strong>
                          {referee.firstName} {referee.lastName}
                        </strong>
                        <small>
                          {referee.grade ?? referee.level ?? 'Unranked'} ·{' '}
                          {referee.compliant
                            ? 'compliance current'
                            : 'compliance needs review'}{' '}
                          · {referee.assignmentCount} assignments
                        </small>
                      </span>
                      {referee.active && (
                        <Button
                          secondary
                          type="button"
                          onClick={() =>
                            void mutate(
                              'Referee removed from the active pool.',
                              () =>
                                post(`/referees/${referee.profileId}/remove`),
                            )
                          }
                        >
                          Remove
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h2>Referee assignments</h2>
              {clubs.length > 0 && (
                <Field label="League program">
                  <Select
                    value={programId}
                    onChange={(event) =>
                      void loadCompetition(event.target.value, true)
                    }
                    options={[
                      { value: '', label: 'Choose a program' },
                      ...entryPrograms.map((program) => ({
                        value: program.programId,
                        label: program.programName,
                      })),
                    ]}
                  />
                </Field>
              )}
              {contests.length > 0 &&
                data.referees.some((item) => item.active) && (
                  <form
                    className="federation-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      const contestValue = form.get('contestId');
                      const contestId =
                        typeof contestValue === 'string' ? contestValue : '';
                      void mutate(
                        'Referee assigned to the league contest.',
                        () =>
                          post(`/contests/${contestId}/assignments`, {
                            personId: form.get('personId'),
                            positionKey: form.get('positionKey'),
                          }),
                      );
                    }}
                  >
                    <Field label="Contest">
                      <Select
                        name="contestId"
                        required
                        options={[
                          { value: '', label: 'Choose a contest' },
                          ...contests.map((contest) => ({
                            value: contest.contestId,
                            label: `${dateTime(contest.startsAt)} · ${contest.teams.map((team) => team.teamName).join(' vs ')}`,
                          })),
                        ]}
                      />
                    </Field>
                    <Field label="Referee">
                      <Select
                        name="personId"
                        required
                        options={[
                          { value: '', label: 'Choose a referee' },
                          ...data.referees
                            .filter((referee) => referee.active)
                            .map((referee) => ({
                              value: referee.personId,
                              label: `${referee.firstName} ${referee.lastName}`,
                            })),
                        ]}
                      />
                    </Field>
                    <Field label="Position">
                      <Select
                        name="positionKey"
                        options={[
                          { value: 'center_referee', label: 'Center referee' },
                          {
                            value: 'assistant_referee',
                            label: 'Assistant referee',
                          },
                          { value: 'timekeeper', label: 'Timekeeper' },
                        ]}
                      />
                    </Field>
                    <Button type="submit" disabled={busy}>
                      Assign referee
                    </Button>
                  </form>
                )}
              {data.assignments.length === 0 ? (
                <p>No league referee assignments yet.</p>
              ) : (
                <ul className="federation-list">
                  {data.assignments.map((assignment) => (
                    <li key={assignment.id}>
                      <span>
                        <strong>
                          {assignment.firstName} {assignment.lastName}
                        </strong>
                        <small>
                          {assignment.positionKey} ·{' '}
                          {dateTime(assignment.startsAt)} · {assignment.status}
                        </small>
                      </span>
                      {!['canceled', 'declined', 'no_show'].includes(
                        assignment.status,
                      ) && (
                        <Button
                          secondary
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void mutate('Referee assignment canceled.', () =>
                              apiPatch(
                                `${base}/referee-assignments/${assignment.id}`,
                                { action: 'cancel' },
                                unknownSchema,
                              ),
                            )
                          }
                        >
                          Cancel assignment
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h2>Federation discipline</h2>
              {clubs.length > 0 && (
                <form
                  className="federation-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void mutate('Federation discipline record issued.', () =>
                      post('/federation-discipline', {
                        memberOrgId: form.get('memberOrgId'),
                        subjectType: form.get('subjectType'),
                        type: form.get('type'),
                        externalTeamId:
                          form.get('subjectType') === 'team'
                            ? form.get('externalTeamId')
                            : undefined,
                        personRef:
                          form.get('subjectType') === 'person'
                            ? form.get('personRef')
                            : undefined,
                        personLabel:
                          form.get('subjectType') === 'person'
                            ? form.get('personLabel')
                            : undefined,
                        description: form.get('description'),
                      }),
                    );
                  }}
                >
                  <Field label="Member club">
                    <Select
                      name="memberOrgId"
                      required
                      value={disciplineMemberId}
                      onChange={(event) => {
                        setDisciplineMemberId(event.target.value);
                      }}
                      options={[
                        { value: '', label: 'Choose a member club' },
                        ...data.members.map((member) => ({
                          value: member.memberOrgId,
                          label: member.memberOrgName,
                        })),
                      ]}
                    />
                  </Field>
                  <Field label="Subject">
                    <Select
                      name="subjectType"
                      value={disciplineSubjectType}
                      onChange={(event) => {
                        setDisciplineSubjectType(
                          event.target.value as 'team' | 'person',
                        );
                      }}
                      options={[
                        { value: 'team', label: 'Team' },
                        { value: 'person', label: 'Person' },
                      ]}
                    />
                  </Field>
                  <Field label="Record type">
                    <Select
                      name="type"
                      options={[
                        'caution',
                        'send_off',
                        'ejection',
                        'technical',
                        'suspension',
                        'fine',
                        'other',
                      ]}
                    />
                  </Field>
                  {disciplineSubjectType === 'team' ? (
                    <Field label="Entered team">
                      <Select
                        name="externalTeamId"
                        required
                        options={[
                          { value: '', label: 'Choose an accepted entry' },
                          ...data.entries
                            .filter(
                              (entry) =>
                                entry.status === 'accepted' &&
                                entry.memberOrgId === disciplineMemberId,
                            )
                            .map((entry) => ({
                              value: entry.externalTeamId,
                              label: entry.teamName,
                            })),
                        ]}
                      />
                    </Field>
                  ) : (
                    <>
                      <Field label="Athlete reference ID">
                        <Input
                          name="personRef"
                          required
                          pattern="[0-9a-fA-F-]{36}"
                        />
                      </Field>
                      <Field label="Athlete name">
                        <Input name="personLabel" required maxLength={200} />
                      </Field>
                    </>
                  )}
                  <Field label="Description">
                    <Textarea
                      name="description"
                      minLength={3}
                      maxLength={4000}
                      required
                    />
                  </Field>
                  <Button type="submit" disabled={busy}>
                    Issue discipline record
                  </Button>
                </form>
              )}
              {data.discipline.length === 0 ? (
                <p>No federation discipline records.</p>
              ) : (
                <ul className="federation-list">
                  {data.discipline.map((record) => (
                    <li key={record.id}>
                      <span>
                        <strong>
                          {record.memberOrgName} ·{' '}
                          {record.personLabel ?? record.teamName ?? record.type}
                        </strong>
                        <small>
                          {record.type} · {record.status} · {record.description}
                        </small>
                      </span>
                      {record.status === 'active' && (
                        <div className="federation-actions">
                          <Button
                            secondary
                            type="button"
                            onClick={() =>
                              void mutate('Appeal recorded.', () =>
                                apiPatch(
                                  `${base}/federation-discipline/${record.id}`,
                                  { action: 'appeal', version: record.version },
                                  unknownSchema,
                                ),
                              )
                            }
                          >
                            Record appeal
                          </Button>
                          <Button
                            secondary
                            type="button"
                            onClick={() =>
                              void mutate('Discipline record overturned.', () =>
                                apiPatch(
                                  `${base}/federation-discipline/${record.id}`,
                                  {
                                    action: 'overturn',
                                    version: record.version,
                                  },
                                  unknownSchema,
                                ),
                              )
                            }
                          >
                            Overturn
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {leagues.length > 0 && (
              <Card>
                <h2>Records involving this club</h2>
                {data.memberDiscipline.length === 0 ? (
                  <p>
                    No federation discipline records have been issued to this
                    club.
                  </p>
                ) : (
                  <ul className="federation-list">
                    {data.memberDiscipline.map((record) => (
                      <li key={record.id}>
                        <span>
                          <strong>
                            {record.type} ·{' '}
                            {record.personLabel ?? record.teamName ?? 'Team'}
                          </strong>
                          <small>
                            From {record.memberOrgName} · {record.status} ·{' '}
                            {record.description}
                          </small>
                        </span>
                        {record.status === 'active' && (
                          <Button
                            secondary
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                'Appeal submitted to the league.',
                                () =>
                                  post(
                                    `/member-discipline/${record.id}/appeal`,
                                    {
                                      version: record.version,
                                    },
                                  ),
                              )
                            }
                          >
                            Appeal record
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
            <Card>
              <h2>League fees and club billing</h2>
              {clubs.length > 0 && (
                <form
                  className="federation-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void mutate('League fee assessed.', () =>
                      post('/fees', {
                        memberOrgId: form.get('memberOrgId'),
                        description: form.get('description'),
                        amountCents: Math.round(
                          Number(form.get('amount')) * 100,
                        ),
                        dueOn: form.get('dueOn') || undefined,
                      }),
                    );
                  }}
                >
                  <Field label="Member club">
                    <Select
                      name="memberOrgId"
                      required
                      options={[
                        { value: '', label: 'Choose a club' },
                        ...data.members.map((member) => ({
                          value: member.memberOrgId,
                          label: member.memberOrgName,
                        })),
                      ]}
                    />
                  </Field>
                  <Field label="Description">
                    <Input name="description" maxLength={500} required />
                  </Field>
                  <Field label="Amount (USD)">
                    <Input
                      name="amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                    />
                  </Field>
                  <Field label="Due date">
                    <Input name="dueOn" type="date" />
                  </Field>
                  <Button type="submit" disabled={busy}>
                    Assess fee
                  </Button>
                </form>
              )}
              {leagues.length > 0 && (
                <form
                  className="federation-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void mutate(
                      'Club billing payer saved for this league.',
                      () =>
                        post('/member-payers', {
                          leagueOrgId: form.get('leagueOrgId'),
                          billingAccountId: form.get('billingAccountId'),
                        }),
                    );
                  }}
                >
                  <Field label="Set payer for a league">
                    <Select
                      name="leagueOrgId"
                      required
                      options={[
                        { value: '', label: 'Choose a league' },
                        ...leagues.map((item) => ({
                          value: item.parentOrgId,
                          label: item.parentOrgName,
                        })),
                      ]}
                    />
                  </Field>
                  <Field label="Organization billing account ID">
                    <Input
                      name="billingAccountId"
                      required
                      pattern="[0-9a-fA-F-]{36}"
                    />
                  </Field>
                  <Button type="submit" disabled={busy}>
                    Save club payer
                  </Button>
                </form>
              )}
              {data.payers.length > 0 && (
                <p>
                  Billing contacts set by member clubs:{' '}
                  {data.payers
                    .map(
                      (payer) =>
                        `${payer.memberOrgName} · ${payer.billingAccountId}`,
                    )
                    .join(', ')}
                </p>
              )}
              {data.fees.length > 0 && (
                <ul className="federation-list">
                  {data.fees.map((fee) => (
                    <li key={fee.id}>
                      <span>
                        <strong>
                          {fee.memberOrgName} · {fee.description}
                        </strong>
                        <small>
                          {money(fee.amountCents)} · {fee.status}
                          {fee.invoiceStatus
                            ? ` · invoice ${fee.invoiceStatus}`
                            : ''}
                          {fee.balanceCents !== null
                            ? ` · balance ${money(fee.balanceCents)}`
                            : ''}
                        </small>
                      </span>
                      {fee.status === 'draft' &&
                        clubs.length > 0 &&
                        data.payers.some(
                          (payer) => payer.memberOrgId === fee.memberOrgId,
                        ) && (
                          <Button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                'Invoice issued to the club’s organization-level payer.',
                                () => post(`/fees/${fee.id}/issue`),
                              )
                            }
                          >
                            Issue invoice
                          </Button>
                        )}
                      {fee.status === 'draft' &&
                        clubs.length > 0 &&
                        !data.payers.some(
                          (payer) => payer.memberOrgId === fee.memberOrgId,
                        ) && (
                          <small>
                            The member club must save a billing account before
                            this invoice can be issued.
                          </small>
                        )}
                    </li>
                  ))}
                </ul>
              )}
              {leagues.length > 0 && (
                <>
                  <h3>Club invoices</h3>
                  {relationshipOptions.length > 0 && (
                    <Field label="League">
                      <Select
                        value={leagueOrgId}
                        onChange={(event) => {
                          setLeagueOrgId(event.target.value);
                        }}
                        options={[
                          { value: '', label: 'Choose a league' },
                          ...leagues.map((item) => ({
                            value: item.parentOrgId,
                            label: item.parentOrgName,
                          })),
                        ]}
                      />
                    </Field>
                  )}
                  <Button
                    type="button"
                    secondary
                    disabled={!leagueOrgId}
                    onClick={() =>
                      void apiGet(
                        `${base}/club-fees?leagueOrgId=${encodeURIComponent(leagueOrgId)}`,
                        unknownSchema,
                      )
                        .then((result) => {
                          setData((prior) => ({
                            ...prior,
                            fees: items<Fee>(result),
                          }));
                        })
                        .catch((cause: unknown) => {
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : 'Club invoices could not be loaded.',
                          );
                        })
                    }
                  >
                    Refresh club invoices
                  </Button>
                </>
              )}
            </Card>
          </>
        )}
        <p className="federation-reload">
          <Button
            secondary
            type="button"
            disabled={busy}
            onClick={() => void reload()}
          >
            Refresh federation data
          </Button>
        </p>
      </main>
    </AppShell>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail: string;
}): React.JSX.Element {
  return (
    <Card className="federation-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </Card>
  );
}

function SharingFields({
  value,
  onChange,
  label,
}: {
  value: Sharing;
  onChange: (sharing: Sharing) => void;
  label: string;
}): React.JSX.Element {
  return (
    <fieldset className="federation-sharing">
      <legend>{label}</legend>
      {shareLabels.map(({ key, label: itemLabel }) => (
        <label key={key}>
          <Checkbox
            checked={Boolean(value[key])}
            onChange={(event) => {
              onChange({ ...value, [key]: event.target.checked });
            }}
          />
          {itemLabel}
        </label>
      ))}
      <small>
        Medical information and compliance documents are never shared.
      </small>
    </fieldset>
  );
}

function EntryList({
  entries,
  busy,
  onReview,
}: {
  entries: Entry[];
  busy: boolean;
  onReview: (entry: Entry, action: 'accept' | 'waitlist' | 'decline') => void;
}): React.JSX.Element {
  const pending = entries.filter((entry) =>
    ['pending_approval', 'pending_payment'].includes(entry.status),
  );
  if (pending.length === 0) return <p>No entries are waiting for review.</p>;
  return (
    <ul className="federation-list">
      {pending.map((entry) => (
        <li key={entry.id}>
          <span>
            <strong>{entry.teamName}</strong>
            <small>
              {entry.memberOrgName} · {entry.programName} · {entry.divisionName}{' '}
              · {entry.snapshot?.playerCount ?? 0} players
            </small>
          </span>
          <div className="federation-actions">
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                onReview(entry, 'accept');
              }}
            >
              Accept
            </Button>
            <Button
              secondary
              type="button"
              disabled={busy}
              onClick={() => {
                onReview(entry, 'waitlist');
              }}
            >
              Waitlist
            </Button>
            <Button
              secondary
              type="button"
              disabled={busy}
              onClick={() => {
                onReview(entry, 'decline');
              }}
            >
              Decline
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function HostedResultButton({
  game,
  teams,
  disabled,
  onSave,
}: {
  game: HostedGame;
  teams: { teamId: string; teamName: string }[];
  disabled: boolean;
  onSave: (body: unknown) => void;
}): React.JSX.Element {
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [firstScore, setFirstScore] = useState('');
  const [secondScore, setSecondScore] = useState('');
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <Button
        secondary
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Enter home result
      </Button>
    );
  return (
    <div className="federation-form">
      <Field label={`${game.title}: home team`}>
        <Select
          value={first}
          onChange={(event) => {
            setFirst(event.target.value);
          }}
          options={[
            { value: '', label: 'Choose team' },
            ...teams.map((team) => ({
              value: team.teamId,
              label: team.teamName,
            })),
          ]}
        />
      </Field>
      <Field label="Home score">
        <Input
          type="number"
          min={0}
          value={firstScore}
          onChange={(event) => {
            setFirstScore(event.target.value);
          }}
        />
      </Field>
      <Field label="Away team">
        <Select
          value={second}
          onChange={(event) => {
            setSecond(event.target.value);
          }}
          options={[
            { value: '', label: 'Choose team' },
            ...teams
              .filter((team) => team.teamId !== first)
              .map((team) => ({ value: team.teamId, label: team.teamName })),
          ]}
        />
      </Field>
      <Field label="Away score">
        <Input
          type="number"
          min={0}
          value={secondScore}
          onChange={(event) => {
            setSecondScore(event.target.value);
          }}
        />
      </Field>
      <Button
        type="button"
        disabled={
          disabled ||
          !first ||
          !second ||
          firstScore === '' ||
          secondScore === ''
        }
        onClick={() => {
          onSave({
            results: [
              { externalTeamId: first, score: Number(firstScore) },
              { externalTeamId: second, score: Number(secondScore) },
            ],
            finalize: true,
          });
        }}
      >
        Submit result
      </Button>
      <Button
        secondary
        type="button"
        onClick={() => {
          setOpen(false);
        }}
      >
        Cancel
      </Button>
    </div>
  );
}
