import { Temporal } from '@js-temporal/polyfill';
import type { StandingsConfig } from '@shared/sport/schema';
import { useCallback, useEffect, useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge, Button, Field, Input, Select, Textarea } from '../../ui';

import { ResourceScheduleCalendar } from './ResourceScheduleCalendar';
import type { ResourceScheduleEvent } from './ResourceScheduleCalendar';
import {
  encodeCsv,
  parseCsvRows,
  printableTableDocument,
  replacePrintDocument,
} from './export';
import './schedule.css';

type ScheduleEvent = {
  id: string;
  title: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  published: boolean;
  version: number;
  programId: string | null;
  divisionId: string | null;
  spaceId: string | null;
  locationText: string | null;
};
type Run = {
  id: string;
  status: string;
  progress: number;
  version: number;
  progress_message?: string;
  result?: {
    unscheduled?: Array<{
      homeTeamId: string;
      awayTeamId: string;
      reasons: string[];
    }>;
    bracketReservations?: Array<{
      id: string;
      round: number;
      homePlaceholder: string;
      awayPlaceholder: string;
      startsAt: string;
      spaceId: string;
    }>;
    unscheduledBracketSlots?: Array<{
      round: number;
      position: number;
      reason: string;
    }>;
  } | null;
};
type ImportRun = {
  id: string;
  fileName: string;
  status: string;
  progress: number;
  version: number;
  result?: {
    imported: number;
    rows: Array<{ row: number; eventId?: string; errors: string[] }>;
  } | null;
  errorMessage?: string | null;
};
type Facility = {
  id: string;
  name: string;
  timezone: string | null;
  public: boolean;
};
type Space = {
  id: string;
  facility_id: string;
  parent_space_id: string | null;
  name: string;
  kind: string;
};
type MeetParticipant = {
  id: string;
  person_id: string | null;
  team_season_id: string | null;
  external_team_id: string | null;
  seed: number | null;
  heat: number | null;
  lane: number | null;
};
type ContestExportResult = {
  participant_id: string;
  side: string;
  score: number | null;
  place: number | null;
  outcome: string | null;
  status: string;
  score_detail: unknown;
};
type ContestStatDefinition = {
  key: string;
  label: { en: string; es: string };
  abbreviation: string;
  level: 'athlete' | 'team';
  valueType: string;
};
type StandingsRow = {
  teamId: string;
  rank: number;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  scored: number;
  allowed: number;
  differential: number;
  points: number;
  winPercentage: number;
};
type StandingsSnapshot = {
  rows: StandingsRow[];
  teamNames: Record<string, string>;
  config: StandingsConfig;
  configVersion: number | null;
  computed_at?: string | null;
  computedAt?: string;
};
type TeamStatsSnapshot = {
  definitions: Array<{
    key: string;
    label: { en: string; es: string };
    abbreviation: string;
    valueType: string;
  }>;
  summary: Record<string, number>;
};
type ProgramStatLeaderboards = {
  items: Array<{
    key: string;
    label: { en: string; es: string };
    abbreviation: string;
    level: 'athlete' | 'team';
    valueType: string;
    leaders: Array<{
      subjectId: string;
      subjectLabel: string;
      value: number;
      rank: number;
    }>;
  }>;
};
type ProgramStatSettings = {
  programId: string;
  version: number;
  enabledStatKeys: string[];
  definitions: Array<{
    key: string;
    label: { en: string; es: string };
    abbreviation: string;
    level: 'athlete' | 'team';
    valueType: string;
    public: boolean;
  }>;
};

const base = (orgId: string, module: string) =>
  `/api/v1/${module}/orgs/${encodeURIComponent(orgId)}`;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
    headers.set('X-Athlentry-Request', '1');
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers,
  });
  const value =
    response.status === 204
      ? null
      : ((await response.json().catch(() => null)) as unknown);
  if (!response.ok) {
    const detail =
      value && typeof value === 'object' && 'message' in value
        ? String(value.message)
        : `Request failed (${String(response.status)}).`;
    throw new Error(detail);
  }
  return value as T;
}

const json = (value: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});
function localInstant(value: string, timezone: string): string {
  return Temporal.PlainDateTime.from(value)
    .toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .toInstant()
    .toString();
}
function localDateTimeInput(value: string, timezone: string): string {
  return Temporal.Instant.from(value)
    .toZonedDateTimeISO(timezone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' });
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  return btoa(binary);
}
function today(offsetDays = 0): string {
  return Temporal.Now.plainDateISO().add({ days: offsetDays }).toString();
}
function weekdayForDate(value: string): string {
  const weekday = Temporal.PlainDate.from(value).dayOfWeek;
  const codes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const code = codes[weekday - 1];
  if (!code) throw new Error('Choose a valid weekday.');
  return code;
}
function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
function awardRecipientLabel(award: Record<string, unknown>): string {
  const first =
    typeof award.recipient_first_name === 'string'
      ? award.recipient_first_name
      : '';
  const last =
    typeof award.recipient_last_name === 'string'
      ? award.recipient_last_name
      : '';
  const team =
    typeof award.recipient_team_name === 'string'
      ? award.recipient_team_name
      : '';
  return [first, last].filter(Boolean).join(' ') || team || 'Award recipient';
}

export function ScheduleConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selectedEvent, setSelectedEvent] = useState('');
  const [programId, setProgramId] = useState('');
  const [divisionId, setDivisionId] = useState('');
  const [generationMode, setGenerationMode] = useState<'league' | 'tournament'>(
    'league',
  );
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [importRun, setImportRun] = useState<ImportRun | null>(null);
  const [seriesId, setSeriesId] = useState('');
  const [contest, setContest] = useState<{
    id: string;
    version: number;
    status: string;
    format?: { format: string; lanes?: number; heats?: boolean };
    participants?: MeetParticipant[];
    results?: ContestExportResult[];
    statDefinitions?: ContestStatDefinition[];
    event?: { title: string; starts_at: string; timezone: string };
  } | null>(null);
  const [standingsScopeType, setStandingsScopeType] = useState<
    'program' | 'division'
  >('program');
  const [standingsScopeId, setStandingsScopeId] = useState('');
  const [standings, setStandings] = useState<StandingsSnapshot | null>(null);
  const [teamStatsTeamId, setTeamStatsTeamId] = useState('');
  const [teamStats, setTeamStats] = useState<TeamStatsSnapshot | null>(null);
  const [programStatLeaders, setProgramStatLeaders] =
    useState<ProgramStatLeaderboards | null>(null);
  const [programStatSettings, setProgramStatSettings] =
    useState<ProgramStatSettings | null>(null);

  const loadEvents = useCallback(async () => {
    setError('');
    const query = new URLSearchParams({
      from: Temporal.Now.instant().subtract({ hours: 168 }).toString(),
      to: Temporal.Now.instant().add({ hours: 2880 }).toString(),
      includeDrafts: 'true',
    });
    try {
      const result = await api<{ items: ScheduleEvent[] }>(
        `${base(orgId, 'scheduling')}/events?${query}`,
      );
      setEvents(result.items);
      if (!selectedEvent && result.items[0])
        setSelectedEvent(result.items[0].id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not load the schedule.',
      );
    }
  }, [orgId, selectedEvent]);

  const loadFacilities = useCallback(async () => {
    try {
      setFacilities(
        (
          await api<{ items: Facility[] }>(
            `${base(orgId, 'scheduling')}/facilities`,
          )
        ).items,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not load facilities.',
      );
    }
  }, [orgId]);

  const loadSpaces = useCallback(async () => {
    try {
      setSpaces(
        (await api<{ items: Space[] }>(`${base(orgId, 'scheduling')}/spaces`))
          .items,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not load spaces.',
      );
    }
  }, [orgId]);

  useEffect(() => {
    void loadEvents();
    void loadFacilities();
    void loadSpaces();
  }, [loadEvents, loadFacilities, loadSpaces]);

  const runId = run?.id;
  const runStatus = run?.status;
  useEffect(() => {
    if (!runId || !runStatus || !['queued', 'running'].includes(runStatus))
      return;
    const source = new EventSource(
      `${base(orgId, 'scheduling')}/generation-runs/${runId}/events`,
    );
    source.addEventListener('progress', (event) => {
      const progress = JSON.parse((event as MessageEvent<string>).data) as Run;
      setRun((current) => (current ? { ...current, ...progress } : progress));
      if (!['queued', 'running'].includes(progress.status)) {
        source.close();
        void api<Run>(`${base(orgId, 'scheduling')}/generation-runs/${runId}`)
          .then(setRun)
          .catch((cause: unknown) => {
            setError(
              cause instanceof Error
                ? cause.message
                : 'Could not load generator results.',
            );
          });
      }
    });
    source.onerror = () => {
      source.close();
    };
    return () => {
      source.close();
    };
  }, [orgId, runId, runStatus]);

  const importRunId = importRun?.id;
  const importRunStatus = importRun?.status;
  useEffect(() => {
    if (
      !importRunId ||
      !importRunStatus ||
      !['queued', 'running'].includes(importRunStatus)
    )
      return;
    const source = new EventSource(
      `${base(orgId, 'scheduling')}/schedule-import-runs/${importRunId}/events`,
    );
    source.addEventListener('progress', (event) => {
      const progress = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as ImportRun;
      setImportRun((current) =>
        current ? { ...current, ...progress } : progress,
      );
      if (!['queued', 'running'].includes(progress.status)) {
        source.close();
        void api<ImportRun>(
          `${base(orgId, 'scheduling')}/schedule-import-runs/${importRunId}`,
        )
          .then(setImportRun)
          .catch((cause: unknown) => {
            setError(
              cause instanceof Error
                ? cause.message
                : 'Could not load import results.',
            );
          });
      }
    });
    source.onerror = () => {
      source.close();
    };
    return () => {
      source.close();
    };
  }, [orgId, importRunId, importRunStatus]);

  async function perform(
    action: () => Promise<unknown>,
    success: string,
  ): Promise<void> {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The change could not be saved.',
      );
    } finally {
      setLoading(false);
    }
  }

  function standingsScope() {
    const id =
      standingsScopeId.trim() ||
      (standingsScopeType === 'program' ? programId.trim() : '');
    return {
      id,
      noun: standingsScopeType === 'program' ? 'programs' : 'divisions',
    };
  }

  function standingsUrl(action = ''): string {
    const scope = standingsScope();
    return `${base(orgId, 'standings')}/${scope.noun}/${encodeURIComponent(scope.id)}/standings${action}`;
  }

  async function loadStandings(): Promise<void> {
    if (!standingsScope().id) {
      setError('Enter a program or division ID first.');
      return;
    }
    await perform(async () => {
      setStandings(await api<StandingsSnapshot>(standingsUrl()));
    }, 'Standings snapshot loaded.');
  }

  async function refreshStandings(): Promise<void> {
    if (!standingsScope().id) {
      setError('Enter a program or division ID first.');
      return;
    }
    await perform(async () => {
      setStandings(
        await api<StandingsSnapshot>(standingsUrl('/refresh'), {
          ...json({}),
          method: 'POST',
        }),
      );
    }, 'Standings refreshed.');
  }

  async function loadTeamStats(): Promise<void> {
    const teamSeasonId = teamStatsTeamId.trim();
    if (!teamSeasonId) {
      setError('Enter a team season ID first.');
      return;
    }
    await perform(async () => {
      setTeamStats(
        await api<TeamStatsSnapshot>(
          `${base(orgId, 'contests')}/teams/${encodeURIComponent(teamSeasonId)}/stats`,
        ),
      );
    }, 'Team statistics loaded.');
  }

  async function loadProgramStatLeaders(): Promise<void> {
    if (!programId.trim()) {
      setError('Enter a program ID before loading its leaderboards.');
      return;
    }
    const query = new URLSearchParams();
    if (divisionId.trim()) query.set('divisionId', divisionId.trim());
    await perform(async () => {
      setProgramStatLeaders(
        await api<ProgramStatLeaderboards>(
          `${base(orgId, 'contests')}/programs/${encodeURIComponent(programId.trim())}/stats/leaders?${query}`,
        ),
      );
    }, 'Program statistics loaded.');
  }

  async function loadProgramStatSettings(): Promise<void> {
    if (!programId.trim()) {
      setError('Enter a program ID before configuring its statistics.');
      return;
    }
    await perform(async () => {
      setProgramStatSettings(
        await api<ProgramStatSettings>(
          `${base(orgId, 'contests')}/programs/${encodeURIComponent(programId.trim())}/stats/settings`,
        ),
      );
    }, 'Program statistics settings loaded.');
  }

  async function saveProgramStatSettings(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!programStatSettings) {
      setError('Load program statistic settings before saving.');
      return;
    }
    await perform(async () => {
      const result = await api<
        Pick<ProgramStatSettings, 'version' | 'enabledStatKeys'>
      >(
        `${base(orgId, 'contests')}/programs/${encodeURIComponent(programStatSettings.programId)}/stats/settings`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: programStatSettings.version,
            enabledStatKeys: programStatSettings.enabledStatKeys,
          }),
        },
      );
      setProgramStatSettings({ ...programStatSettings, ...result });
      setProgramStatLeaders(null);
      await loadContest();
    }, 'Program statistics settings saved.');
  }

  async function saveStandingsVisibility(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!standings || !standingsScope().id) {
      setError('Load standings before changing their visibility.');
      return;
    }
    const form = new FormData(event.currentTarget);
    const config = {
      ...standings.config,
      publicVisibility: formText(form, 'publicVisibility'),
    } as StandingsConfig;
    await perform(async () => {
      const result = await api<{ version: number }>(standingsUrl('/config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config,
          ...(standings.configVersion === null
            ? {}
            : { expectedVersion: standings.configVersion }),
        }),
      });
      setStandings({
        ...standings,
        config,
        configVersion: result.version,
      });
    }, 'Standings visibility saved.');
  }

  function printStandings(): void {
    if (!standings) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setError('Allow the print window to open, then try again.');
      return;
    }
    const rows = standings.rows.map((row) => [
      row.rank,
      standings.teamNames[row.teamId] ?? row.teamId,
      row.played,
      row.wins,
      row.losses,
      row.ties,
      row.points,
      row.scored,
      row.allowed,
      row.differential,
    ]);
    const scope = standingsScope();
    const computedAt = standings.computedAt ?? standings.computed_at;
    replacePrintDocument(
      printWindow.document,
      printableTableDocument(
        'Standings',
        `${standingsScopeType} ${scope.id}${computedAt ? ` · Updated ${new Date(computedAt).toLocaleString()}` : ' · Live calculation'}`,
        [
          'Rank',
          'Team',
          'Played',
          'Wins',
          'Losses',
          'Ties',
          'Points',
          'Scored',
          'Allowed',
          'Differential',
        ],
        rows,
      ),
    );
    printWindow.focus();
    window.setTimeout(() => {
      printWindow.print();
    }, 250);
    setMessage('Standings print view ready.');
  }

  async function createEvent(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const home = formText(form, 'home').trim();
    const away = formText(form, 'away').trim();
    const people = formText(form, 'personIds')
      .split(/[\s,]+/)
      .filter(Boolean);
    await perform(async () => {
      await api(
        `${base(orgId, 'scheduling')}/events`,
        json({
          title: formText(form, 'title'),
          kind: formText(form, 'kind'),
          startsAt: localInstant(formText(form, 'startsAt'), timezone),
          endsAt: localInstant(formText(form, 'endsAt'), timezone),
          timezone,
          programId: formText(form, 'programId') || null,
          divisionId: formText(form, 'divisionId') || null,
          spaceId: formText(form, 'spaceId') || null,
          locationText: formText(form, 'locationText') || null,
          arrivalMinutesBefore: Number(form.get('arrivalMinutesBefore') || 0),
          published: false,
          ...(formText(form, 'overrideReason').trim()
            ? { overrideReason: formText(form, 'overrideReason').trim() }
            : {}),
          participants: [
            ...(home ? [{ type: 'team', id: home, side: 'home' }] : []),
            ...(away ? [{ type: 'team', id: away, side: 'away' }] : []),
            ...people.map((id) => ({ type: 'person', id, side: 'none' })),
          ],
        }),
      );
      await loadEvents();
    }, 'Event saved as a draft.');
    formElement.reset();
  }

  async function saveEvent(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const selected = events.find((item) => item.id === selectedEvent);
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    await perform(async () => {
      await api(
        `${base(orgId, 'scheduling')}/events/${encodeURIComponent(selected.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: selected.version,
            title: formText(form, 'editTitle'),
            startsAt: localInstant(
              formText(form, 'editStartsAt'),
              selected.timezone,
            ),
            endsAt: localInstant(
              formText(form, 'editEndsAt'),
              selected.timezone,
            ),
            timezone: selected.timezone,
            locationText: formText(form, 'editLocation') || null,
            ...(formText(form, 'editOverrideReason').trim()
              ? {
                  overrideReason: formText(form, 'editOverrideReason').trim(),
                }
              : {}),
          }),
        },
      );
      await loadEvents();
    }, 'Event updated.');
  }

  async function moveCalendarEvent(
    event: ResourceScheduleEvent,
    destination: {
      startsAt: string;
      endsAt: string;
      spaceId: string | null;
      timezone: string;
      overrideReason?: string;
    },
  ): Promise<void> {
    await api(
      `${base(orgId, 'scheduling')}/events/${encodeURIComponent(event.id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: event.version,
          startsAt: destination.startsAt,
          endsAt: destination.endsAt,
          timezone: destination.timezone,
          spaceId: destination.spaceId,
          locationText: destination.spaceId ? null : event.locationText,
          ...(destination.overrideReason
            ? { overrideReason: destination.overrideReason }
            : {}),
        }),
      },
    );
    await loadEvents();
  }

  async function createGeneration(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await perform(async () => {
      const shared = {
        seed: Number(form.get('seed')),
        seasonStartsOn: formText(form, 'seasonStartsOn'),
        seasonEndsOn: formText(form, 'seasonEndsOn'),
        maxGamesPerTeamPerDay: 1,
        minRestHours: 18,
        timeBudgetSeconds: 45,
      };
      const response = await api<{ id: string }>(
        `${base(orgId, 'scheduling')}/programs/${encodeURIComponent(programId)}/generation-runs`,
        json(
          generationMode === 'tournament'
            ? {
                ...shared,
                tournament: {
                  bracketId: formText(form, 'bracketId').trim(),
                  poolDays: formText(form, 'poolDays')
                    .split(/[\s,]+/)
                    .map((day) => day.trim())
                    .filter(Boolean)
                    .sort(),
                  poolTimeWindow: {
                    start: formText(form, 'windowStart'),
                    end: formText(form, 'windowEnd'),
                  },
                },
              }
            : {
                ...shared,
                divisions: [
                  {
                    divisionId,
                    gamesPerTeam: Number(form.get('gamesPerTeam')),
                    allowedWeekdays: [6],
                    timeWindows: [
                      {
                        start: formText(form, 'windowStart'),
                        end: formText(form, 'windowEnd'),
                      },
                    ],
                  },
                ],
              },
        ),
      );
      setRun({ id: response.id, status: 'queued', progress: 0, version: 1 });
    }, 'Generator run queued.');
  }

  async function startImport(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem('scheduleFile');
    if (!(input instanceof HTMLInputElement) || !input.files?.[0]) {
      setError('Choose a CSV or XLSX file to import.');
      return;
    }
    const file = input.files[0];
    if (file.size > 20 * 1024 * 1024) {
      setError('Imports are limited to 20 MB.');
      return;
    }
    const encoded = base64(new Uint8Array(await file.arrayBuffer()));
    await perform(async () => {
      const response = await api<{ id: string; status: string }>(
        `${base(orgId, 'scheduling')}/schedule.csv/import`,
        json({ fileName: file.name, contentBase64: encoded }),
      );
      setImportRun({
        id: response.id,
        fileName: file.name,
        status: 'queued',
        progress: 0,
        version: 1,
      });
    }, 'Import validation started.');
  }

  async function exportSchedule(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const toDate = Temporal.PlainDate.from(formText(form, 'to'))
      .add({ days: 1 })
      .toString();
    const query = new URLSearchParams({
      scope: formText(form, 'scopeType'),
      id: formText(form, 'scopeId'),
      from: new Date(`${formText(form, 'from')}T00:00:00Z`).toISOString(),
      to: new Date(`${toDate}T00:00:00Z`).toISOString(),
    });
    const format =
      event.nativeEvent.submitter instanceof HTMLButtonElement
        ? event.nativeEvent.submitter.value
        : 'csv';
    const printWindow = format === 'pdf' ? window.open('', '_blank') : null;
    if (format === 'pdf' && !printWindow) {
      setError('Allow the print window to open, then try again.');
      return;
    }
    if (printWindow) {
      printWindow.document.title = 'Preparing schedule';
      printWindow.document.body.textContent = 'Preparing schedule print view…';
    }
    await perform(
      async () => {
        const response = await fetch(
          `${base(orgId, 'scheduling')}/schedule.csv?${query}`,
          { credentials: 'include' },
        );
        if (!response.ok)
          throw new Error(
            `Schedule export failed (${String(response.status)}).`,
          );
        const text = await response.text();
        if (format === 'pdf' && printWindow) {
          const [header = [], ...records] = parseCsvRows(text);
          const column = (name: string) => header.indexOf(name);
          const value = (record: string[], name: string) =>
            record[column(name)] ?? '';
          const rows = records.map((record) => {
            const timezoneValue = value(record, 'timezone') || 'UTC';
            const start = value(record, 'starts_at');
            const end = value(record, 'ends_at');
            const date = new Intl.DateTimeFormat(undefined, {
              dateStyle: 'medium',
              timeZone: timezoneValue,
            }).format(new Date(start));
            const times = `${new Intl.DateTimeFormat(undefined, {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: timezoneValue,
            }).format(new Date(start))}–${new Intl.DateTimeFormat(undefined, {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: timezoneValue,
            }).format(new Date(end))}`;
            return [
              date,
              times,
              timezoneValue,
              value(record, 'title'),
              value(record, 'kind'),
              value(record, 'space_name') ||
                value(record, 'location_text') ||
                'Unassigned',
              value(record, 'home_team'),
              value(record, 'away_team'),
              value(record, 'status'),
            ];
          });
          const title = 'Schedule export';
          const subtitle = `${formText(form, 'scopeType')} ${formText(form, 'scopeId')} · ${formText(form, 'from')} to ${formText(form, 'to')}`;
          replacePrintDocument(
            printWindow.document,
            printableTableDocument(
              title,
              subtitle,
              [
                'Date',
                'Time',
                'Time zone',
                'Event',
                'Type',
                'Location',
                'Home',
                'Away',
                'Status',
              ],
              rows,
            ),
          );
          printWindow.focus();
          window.setTimeout(() => {
            printWindow.print();
          }, 250);
        } else {
          const objectUrl = URL.createObjectURL(
            new Blob([text], { type: 'text/csv;charset=utf-8' }),
          );
          const anchor = document.createElement('a');
          anchor.href = objectUrl;
          anchor.download = 'schedule.csv';
          anchor.click();
          URL.revokeObjectURL(objectUrl);
        }
      },
      format === 'pdf' ? 'Print view ready.' : 'CSV downloaded.',
    );
  }

  function exportContestResults(format: 'csv' | 'pdf'): void {
    if (!contest?.results?.length) {
      setError('Load a contest with entered results before exporting.');
      return;
    }
    const participantById = new Map(
      (contest.participants ?? []).map((participant) => [
        participant.id,
        participant.person_id ??
          participant.team_season_id ??
          participant.external_team_id ??
          participant.id,
      ]),
    );
    const rows = contest.results.map((result) => [
      participantById.get(result.participant_id) ?? result.participant_id,
      result.side,
      result.score,
      result.place,
      result.outcome,
      result.status,
      result.score_detail,
    ]);
    const headers = [
      'Participant',
      'Side',
      'Score',
      'Place',
      'Outcome',
      'Status',
      'Result detail',
    ];
    const title = `${contest.event?.title ?? 'Contest'} results`;
    const subtitle = contest.event
      ? `${new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeZone: contest.event.timezone,
        }).format(new Date(contest.event.starts_at))} · ${contest.status}`
      : `Contest ${contest.id} · ${contest.status}`;
    if (format === 'csv') {
      const objectUrl = URL.createObjectURL(
        new Blob([encodeCsv([headers, ...rows])], {
          type: 'text/csv;charset=utf-8',
        }),
      );
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = 'contest-results.csv';
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setMessage('Results CSV downloaded.');
      return;
    }
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setError('Allow the print window to open, then try again.');
      return;
    }
    replacePrintDocument(
      printWindow.document,
      printableTableDocument(title, subtitle, headers, rows),
    );
    printWindow.focus();
    window.setTimeout(() => {
      printWindow.print();
    }, 250);
    setMessage('Results print view ready.');
  }

  async function createSeries(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await perform(async () => {
      const result = await api<{ seriesId: string }>(
        `${base(orgId, 'scheduling')}/event-series`,
        json({
          recurrence: {
            kind: 'weekly',
            interval: 1,
            byDay: [formText(form, 'weekday')],
            startsOn: formText(form, 'startsOn'),
            endsOn: formText(form, 'endsOn'),
            exceptions: [],
            additions: [],
          },
          startTime: formText(form, 'startTime'),
          durationMinutes: Number(form.get('durationMinutes')),
          timezone,
          ...(formText(form, 'seriesOverrideReason').trim()
            ? {
                overrideReason: formText(form, 'seriesOverrideReason').trim(),
              }
            : {}),
          template: {
            kind: formText(form, 'kind'),
            title: formText(form, 'title'),
            programId: formText(form, 'programId') || null,
            divisionId: formText(form, 'divisionId') || null,
            spaceId: formText(form, 'spaceId') || null,
            locationText: formText(form, 'locationText') || null,
            arrivalMinutesBefore: 0,
            participants: [],
            published: false,
          },
        }),
      );
      setSeriesId(result.seriesId);
      await loadEvents();
    }, 'Recurring series created. Its ID is ready in the edit form.');
  }

  async function editSeries(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const scope = formText(form, 'scope') as 'this' | 'following' | 'all';
    const occurrenceStartsAt = new Date(
      localInstant(formText(form, 'occurrenceStartsAt'), timezone),
    ).toISOString();
    const payload: Record<string, unknown> = {
      scope,
      occurrenceStartsAt,
      expectedVersion: Number(form.get('seriesVersion')),
      ...(formText(form, 'seriesOverrideReason').trim()
        ? { overrideReason: formText(form, 'seriesOverrideReason').trim() }
        : {}),
    };
    const title = formText(form, 'title').trim();
    if (title) payload.template = { title };
    if (scope === 'this') {
      const newStartsAt = formText(form, 'newStartsAt');
      const newEndsAt = formText(form, 'newEndsAt');
      if (Boolean(newStartsAt) !== Boolean(newEndsAt)) {
        setError('Choose both a new start and end time.');
        return;
      }
      if (newStartsAt) {
        payload.startsAt = new Date(
          localInstant(newStartsAt, timezone),
        ).toISOString();
        payload.endsAt = new Date(
          localInstant(newEndsAt, timezone),
        ).toISOString();
      }
    } else {
      const startsOn = formText(form, 'startsOn');
      const endsOn = formText(form, 'endsOn');
      payload.recurrence = {
        timezone,
        startTime: formText(form, 'seriesStartTime'),
        durationMinutes: Number(form.get('seriesDuration')),
        recurrence: {
          kind: 'weekly',
          interval: 1,
          byDay: [formText(form, 'weekday')],
          startsOn,
          endsOn,
          exceptions: [],
          additions: [],
        },
      };
    }
    await perform(async () => {
      await api(
        `${base(orgId, 'scheduling')}/event-series/${encodeURIComponent(seriesId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      await loadEvents();
    }, 'Series changes saved.');
  }

  async function createContestForEvent(): Promise<void> {
    if (!selectedEvent) return;
    await api(
      `${base(orgId, 'contests')}/events/${selectedEvent}/contests`,
      json({ formatIndex: 0, stage: 'regular', countsForStandings: true }),
    );
    await loadContest();
  }

  async function loadContest(): Promise<void> {
    if (!selectedEvent) return;
    const result = await api<{
      contest: { id: string; version: number; status: string };
      format: { format: string; lanes?: number; heats?: boolean };
    } | null>(`${base(orgId, 'contests')}/events/${selectedEvent}/results`);
    if (!result) {
      setContest(null);
      setMessage('No contest has been created for this event.');
      return;
    }
    const detail = await api<{
      participants: MeetParticipant[];
      format: { format: string; lanes?: number; heats?: boolean };
      results: ContestExportResult[];
      statDefinitions: ContestStatDefinition[];
      event: { title: string; starts_at: string; timezone: string };
    }>(`${base(orgId, 'contests')}/contests/${result.contest.id}`);
    setContest({
      ...result.contest,
      format: detail.format,
      participants: detail.participants,
      results: detail.results,
      statDefinitions: detail.statDefinitions,
      event: detail.event,
    });
  }

  async function submitResult(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!contest) return;
    const form = new FormData(event.currentTarget);
    let result: unknown;
    try {
      result = JSON.parse(formText(form, 'resultJson'));
    } catch {
      setError('Enter valid JSON that matches the contest format.');
      return;
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      setError('Result JSON must be an object.');
      return;
    }
    const statInputs = (contest.statDefinitions ?? []).flatMap((definition) =>
      (contest.participants ?? []).flatMap((participant) => {
        const eligible =
          definition.level === 'athlete'
            ? participant.person_id !== null
            : participant.team_season_id !== null;
        if (!eligible) return [];
        const fieldName = `stat:${participant.id}:${definition.key}`;
        const value = form.get(fieldName);
        if (typeof value !== 'string' || value.trim() === '') return [];
        return [
          {
            participantId: participant.id,
            statKey: definition.key,
            abbreviation: definition.abbreviation,
            valueType: definition.valueType,
            value: Number(value),
          },
        ];
      }),
    );
    const invalidStat = statInputs.find(
      (stat) =>
        !Number.isFinite(stat.value) ||
        stat.value < 0 ||
        (stat.valueType === 'integer' && !Number.isSafeInteger(stat.value)),
    );
    if (invalidStat) {
      setError(
        `${invalidStat.abbreviation} must be a valid non-negative value.`,
      );
      return;
    }
    const enteredStats = statInputs.map((stat) => ({
      participantId: stat.participantId,
      statKey: stat.statKey,
      value: stat.value,
    }));
    result = { ...result, stats: enteredStats };
    await perform(async () => {
      const response = await api<{ version: number; status: string }>(
        `${base(orgId, 'contests')}/contests/${contest.id}/results`,
        json({
          expectedVersion: contest.version,
          finalize: form.get('finalize') === 'on',
          result,
        }),
      );
      setContest({ ...contest, ...response });
      await loadEvents();
      await loadContest();
    }, 'Result submitted.');
  }

  const selected = events.find((item) => item.id === selectedEvent);

  return (
    <main className="schedule-page">
      <header className="schedule-page__header">
        <div>
          <p className="schedule-page__eyebrow">Organization operations</p>
          <h1>Schedule &amp; facilities</h1>
          <p>Plan events, assign spaces, and manage game day.</p>
        </div>
        <Button
          secondary
          onClick={() => {
            void loadEvents();
            void loadFacilities();
            void loadSpaces();
          }}
        >
          Refresh schedule
        </Button>
      </header>
      {(error || message) && (
        <div
          className={`schedule-notice${error ? ' schedule-notice--error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error || message}
        </div>
      )}

      <ResourceScheduleCalendar
        events={events}
        resources={spaces.map((space) => ({
          id: space.id,
          name: space.name,
          timezone:
            facilities.find((facility) => facility.id === space.facility_id)
              ?.timezone ?? timezone,
        }))}
        timezone={timezone}
        onMove={moveCalendarEvent}
      />

      <section
        className="schedule-card"
        aria-labelledby="schedule-events-heading"
      >
        <div className="schedule-card__title">
          <div>
            <h2 id="schedule-events-heading">Events</h2>
            <p>Drafts stay private until published.</p>
          </div>
          <Badge tone="neutral">{events.length} loaded</Badge>
        </div>
        <div className="table-scroll">
          <table className="ui-table schedule-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Start</th>
                <th>Place</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {events.map((item) => (
                <tr key={item.id}>
                  <td>
                    <button
                      type="button"
                      className="schedule-text-button"
                      onClick={() => {
                        setSelectedEvent(item.id);
                      }}
                      aria-pressed={selectedEvent === item.id}
                    >
                      {item.title}
                    </button>
                    <small>{item.kind}</small>
                  </td>
                  <td>
                    <time dateTime={item.startsAt}>
                      {new Date(item.startsAt).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                  </td>
                  <td>
                    {item.locationText ??
                      (item.spaceId
                        ? `Space ${item.spaceId.slice(0, 8)}`
                        : '—')}
                  </td>
                  <td>
                    <Badge tone={item.published ? 'confirmed' : 'pending'}>
                      {item.published ? 'Published' : 'Draft'}
                    </Badge>
                  </td>
                  <td>
                    {!item.published && (
                      <Button
                        secondary
                        disabled={loading}
                        onClick={() =>
                          void perform(async () => {
                            await api(
                              `${base(orgId, 'scheduling')}/events/${item.id}/publish`,
                              json({ expectedVersion: item.version }),
                            );
                            await loadEvents();
                          }, 'Event published.')
                        }
                      >
                        Publish
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {!events.length && (
                <tr>
                  <td colSpan={5}>No events in this date range.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {selected && (
          <details className="schedule-details">
            <summary>Edit selected event</summary>
            <form
              className="schedule-form schedule-form--two"
              onSubmit={(event) => void saveEvent(event)}
            >
              <Field label="Event title" required>
                <Input
                  name="editTitle"
                  required
                  maxLength={200}
                  defaultValue={selected.title}
                />
              </Field>
              <Field label="Start (event timezone)" required>
                <Input
                  name="editStartsAt"
                  type="datetime-local"
                  required
                  defaultValue={localDateTimeInput(
                    selected.startsAt,
                    selected.timezone,
                  )}
                />
              </Field>
              <Field label="End (event timezone)" required>
                <Input
                  name="editEndsAt"
                  type="datetime-local"
                  required
                  defaultValue={localDateTimeInput(
                    selected.endsAt,
                    selected.timezone,
                  )}
                />
              </Field>
              <Field label="Location text">
                <Input
                  name="editLocation"
                  maxLength={500}
                  defaultValue={selected.locationText ?? ''}
                />
              </Field>
              <Field
                label="Soft conflict override reason"
                hint="Only used if the server reports an overridable team, coach, or official conflict. Space conflicts cannot be overridden."
              >
                <Input
                  name="editOverrideReason"
                  minLength={10}
                  maxLength={500}
                />
              </Field>
              <Button type="submit" disabled={loading}>
                Save event changes
              </Button>
            </form>
            <Button
              secondary
              disabled={loading || selected.kind !== 'game'}
              onClick={() =>
                void perform(async () => {
                  await api(
                    `${base(orgId, 'scheduling')}/events/${selected.id}/swap-home-away`,
                    json({ expectedVersion: selected.version }),
                  );
                  await loadEvents();
                }, 'Home and away teams swapped.')
              }
            >
              Swap home and away
            </Button>
            <details className="schedule-details">
              <summary>Request a reschedule</summary>
              <form
                className="schedule-form schedule-form--two"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void perform(async () => {
                    await api(
                      `${base(orgId, 'scheduling')}/events/${selected.id}/reschedule-requests`,
                      json({
                        reason: formText(form, 'rescheduleReason'),
                        proposedSlots: [
                          {
                            startsAt: localInstant(
                              formText(form, 'proposedStartsAt'),
                              selected.timezone,
                            ),
                            endsAt: localInstant(
                              formText(form, 'proposedEndsAt'),
                              selected.timezone,
                            ),
                            ...(formText(form, 'proposedSpaceId')
                              ? { spaceId: formText(form, 'proposedSpaceId') }
                              : {}),
                          },
                        ],
                      }),
                    );
                  }, 'Reschedule request submitted.');
                }}
              >
                <Field label="Reason" required>
                  <Textarea
                    name="rescheduleReason"
                    required
                    minLength={10}
                    maxLength={1000}
                    rows={2}
                  />
                </Field>
                <Field label="Proposed start (event timezone)" required>
                  <Input
                    name="proposedStartsAt"
                    type="datetime-local"
                    required
                  />
                </Field>
                <Field label="Proposed end (event timezone)" required>
                  <Input name="proposedEndsAt" type="datetime-local" required />
                </Field>
                <Field label="Proposed space ID">
                  <Input name="proposedSpaceId" />
                </Field>
                <Button type="submit" disabled={loading}>
                  Send reschedule request
                </Button>
              </form>
            </details>
          </details>
        )}
        <details className="schedule-details">
          <summary>Create an event</summary>
          <form
            className="schedule-form"
            onSubmit={(event) => void createEvent(event)}
          >
            <Field label="Title" required>
              <Input name="title" required maxLength={200} />
            </Field>
            <Field label="Event type" required>
              <Select
                name="kind"
                options={[
                  'game',
                  'practice',
                  'meet',
                  'match',
                  'class_session',
                  'tournament_game',
                  'meeting',
                  'other',
                ]}
              />
            </Field>
            <Field label="Start (local time)" required>
              <Input name="startsAt" type="datetime-local" required />
            </Field>
            <Field label="End (local time)" required>
              <Input name="endsAt" type="datetime-local" required />
            </Field>
            <Field label="Timezone" required>
              <Input
                value={timezone}
                onChange={(event) => {
                  setTimezone(event.target.value);
                }}
                required
              />
            </Field>
            <Field label="Program ID">
              <Input
                name="programId"
                value={programId}
                onChange={(event) => {
                  setProgramId(event.target.value);
                  setProgramStatSettings(null);
                  setProgramStatLeaders(null);
                }}
              />
            </Field>
            <Field label="Division ID">
              <Input
                name="divisionId"
                value={divisionId}
                onChange={(event) => {
                  setDivisionId(event.target.value);
                }}
              />
            </Field>
            <Field label="Space ID">
              <Input name="spaceId" />
            </Field>
            <Field label="Home team season ID">
              <Input name="home" />
            </Field>
            <Field label="Away team season ID">
              <Input name="away" />
            </Field>
            <Field
              label="Individual meet participant person IDs"
              hint="For timed or measured meets, enter athlete IDs separated by commas or spaces."
            >
              <Textarea name="personIds" rows={3} />
            </Field>
            <Field label="Free-text location">
              <Input name="locationText" maxLength={500} />
            </Field>
            <Field
              label="Soft conflict override reason"
              hint="Only used if the server reports an overridable team, coach, or official conflict. Space conflicts cannot be overridden."
            >
              <Input name="overrideReason" minLength={10} maxLength={500} />
            </Field>
            <Field label="Arrival time before event (minutes)">
              <Input
                name="arrivalMinutesBefore"
                type="number"
                min={0}
                max={1440}
                defaultValue={0}
              />
            </Field>
            <Button type="submit" disabled={loading}>
              Save draft
            </Button>
          </form>
        </details>
      </section>

      <div className="schedule-grid">
        <section
          className="schedule-card"
          aria-labelledby="schedule-generator-heading"
        >
          <h2 id="schedule-generator-heading">Schedule generator</h2>
          <p>
            Generate a deterministic draft, review every unplaced game, then
            apply or discard.
          </p>
          <form
            className="schedule-form schedule-form--two"
            onSubmit={(event) => void createGeneration(event)}
          >
            <Field label="Schedule type" required>
              <Select
                aria-label="Schedule type"
                value={generationMode}
                onChange={(event) => {
                  setGenerationMode(
                    event.target.value === 'tournament'
                      ? 'tournament'
                      : 'league',
                  );
                }}
                options={[
                  { value: 'league', label: 'Division schedule' },
                  { value: 'tournament', label: 'Tournament pool and bracket' },
                ]}
              />
            </Field>
            <Field label="Program ID" required>
              <Input
                value={programId}
                onChange={(event) => {
                  setProgramId(event.target.value);
                  setProgramStatSettings(null);
                  setProgramStatLeaders(null);
                }}
                required
              />
            </Field>
            {generationMode === 'league' ? (
              <Field label="Division ID" required>
                <Input
                  value={divisionId}
                  onChange={(event) => {
                    setDivisionId(event.target.value);
                  }}
                  required
                />
              </Field>
            ) : (
              <>
                <Field label="Tournament bracket ID" required>
                  <Input name="bracketId" required />
                </Field>
                <Field label="Pool dates (comma separated YYYY-MM-DD)" required>
                  <Input
                    name="poolDays"
                    placeholder="2026-06-05, 2026-06-06"
                    required
                  />
                </Field>
              </>
            )}
            <Field label="Season starts" required>
              <Input
                name="seasonStartsOn"
                type="date"
                defaultValue={today()}
                required
              />
            </Field>
            <Field label="Season ends" required>
              <Input
                name="seasonEndsOn"
                type="date"
                defaultValue={today(90)}
                required
              />
            </Field>
            {generationMode === 'league' && (
              <Field label="Games per team" required>
                <Input
                  name="gamesPerTeam"
                  type="number"
                  min={1}
                  max={100}
                  defaultValue={8}
                  required
                />
              </Field>
            )}
            <Field label="Random seed" required>
              <Input
                name="seed"
                type="number"
                min={0}
                max={2147483647}
                defaultValue={1}
                required
              />
            </Field>
            <Field label="First available start">
              <Input
                name="windowStart"
                type="time"
                defaultValue="08:00"
                required
              />
            </Field>
            <Field label="Last available start">
              <Input
                name="windowEnd"
                type="time"
                defaultValue="18:00"
                required
              />
            </Field>
            <Button
              type="submit"
              disabled={
                loading ||
                !programId ||
                (generationMode === 'league' && !divisionId)
              }
            >
              Generate draft
            </Button>
          </form>
          {run && (
            <div className="schedule-run" aria-live="polite">
              <div className="schedule-card__title">
                <strong>Run {run.id.slice(0, 8)}</strong>
                <Badge
                  tone={
                    run.status === 'succeeded'
                      ? 'ok'
                      : run.status === 'failed'
                        ? 'bad'
                        : 'pending'
                  }
                >
                  {run.status}
                </Badge>
              </div>
              <progress
                value={run.progress}
                max={100}
                aria-label="Schedule generation progress"
              />
              <p>
                {run.progress_message ?? `${String(run.progress)}% complete`}
              </p>
              {run.result?.unscheduled?.length ? (
                <div>
                  <h3>Unscheduled games</h3>
                  <ul>
                    {run.result.unscheduled.map((item, index) => (
                      <li
                        key={`${item.homeTeamId}-${item.awayTeamId}-${String(index)}`}
                      >
                        Game not placed: {item.reasons.join(', ')}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                run.status === 'succeeded' && (
                  <p>All requested games were placed.</p>
                )
              )}
              {run.result?.bracketReservations?.length ? (
                <div>
                  <h3>Reserved bracket slots</h3>
                  <ul>
                    {run.result.bracketReservations.map((slot) => (
                      <li key={slot.id}>
                        Round {String(slot.round)}: {slot.homePlaceholder} vs{' '}
                        {slot.awayPlaceholder} at{' '}
                        {new Date(slot.startsAt).toLocaleString()}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {run.result?.unscheduledBracketSlots?.length ? (
                <div>
                  <h3>Unreserved bracket games</h3>
                  <ul>
                    {run.result.unscheduledBracketSlots.map((slot) => (
                      <li
                        key={`${String(slot.round)}-${String(slot.position)}`}
                      >
                        Round {String(slot.round)}, game {String(slot.position)}
                        : {slot.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {run.status === 'succeeded' && (
                <div className="schedule-actions">
                  <Button
                    disabled={loading}
                    onClick={() =>
                      void perform(async () => {
                        await api(
                          `${base(orgId, 'scheduling')}/generation-runs/${run.id}/apply`,
                          json({ expectedVersion: run.version }),
                        );
                        setRun({ ...run, status: 'applied' });
                        await loadEvents();
                      }, 'Generated schedule applied.')
                    }
                  >
                    Apply draft
                  </Button>
                  <Button
                    secondary
                    disabled={loading}
                    onClick={() =>
                      void perform(async () => {
                        await api(
                          `${base(orgId, 'scheduling')}/generation-runs/${run.id}/discard`,
                          json({ expectedVersion: run.version }),
                        );
                        setRun({ ...run, status: 'discarded' });
                      }, 'Generated schedule discarded.')
                    }
                  >
                    Discard
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>

        <section
          className="schedule-card"
          aria-labelledby="schedule-tools-heading"
        >
          <h2 id="schedule-tools-heading">Import and schedule tools</h2>
          <form
            className="schedule-form"
            onSubmit={(event) => void startImport(event)}
          >
            <Field
              label="CSV file"
              hint="Up to 20 MB and 20,000 rows. Imports are validated before commit."
              required
            >
              <Input name="scheduleFile" type="file" accept=".csv" required />
            </Field>
            <Button type="submit" disabled={loading}>
              Validate import
            </Button>
          </form>
          {importRun && (
            <div className="schedule-run" aria-live="polite">
              <div className="schedule-card__title">
                <strong>{importRun.fileName}</strong>
                <Badge
                  tone={
                    importRun.status === 'ready'
                      ? 'ok'
                      : importRun.status === 'invalid' ||
                          importRun.status === 'failed'
                        ? 'bad'
                        : 'pending'
                  }
                >
                  {importRun.status}
                </Badge>
              </div>
              <progress
                value={importRun.progress}
                max={100}
                aria-label="Import validation progress"
              />
              {importRun.errorMessage && (
                <p role="alert">{importRun.errorMessage}</p>
              )}
              {importRun.result && (
                <>
                  <p>{importRun.result.imported} rows can be imported.</p>
                  <div className="table-scroll">
                    <table className="ui-table">
                      <thead>
                        <tr>
                          <th>Row</th>
                          <th>Validation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importRun.result.rows.map((row) => (
                          <tr key={row.row}>
                            <td>{row.row}</td>
                            <td>
                              {row.errors.length
                                ? row.errors.join('; ')
                                : 'Ready'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {importRun.status === 'ready' && (
                <div className="schedule-actions">
                  <Button
                    disabled={loading}
                    onClick={() =>
                      void perform(async () => {
                        const result = await api<{
                          committed: boolean;
                          imported: number;
                          status: string;
                        }>(
                          `${base(orgId, 'scheduling')}/schedule-import-runs/${importRun.id}/commit`,
                          {
                            ...json({ expectedVersion: importRun.version }),
                            method: 'POST',
                          },
                        );
                        setImportRun({
                          ...importRun,
                          status: result.status,
                          version: importRun.version + 1,
                        });
                        await loadEvents();
                      }, 'Import committed.')
                    }
                  >
                    Commit import
                  </Button>
                  <Button
                    secondary
                    disabled={loading}
                    onClick={() =>
                      void perform(async () => {
                        await api(
                          `${base(orgId, 'scheduling')}/schedule-import-runs/${importRun.id}/discard`,
                          json({ expectedVersion: importRun.version }),
                        );
                        setImportRun({ ...importRun, status: 'discarded' });
                      }, 'Import discarded.')
                    }
                  >
                    Discard import
                  </Button>
                </div>
              )}
            </div>
          )}
          <form
            className="schedule-form schedule-form--two"
            onSubmit={(event) => void exportSchedule(event)}
          >
            <Field label="Export scope">
              <Select
                name="scopeType"
                options={['program', 'division', 'team']}
              />
            </Field>
            <Field label="Scope ID" required>
              <Input name="scopeId" required />
            </Field>
            <Field label="From date" required>
              <Input name="from" type="date" defaultValue={today()} required />
            </Field>
            <Field label="To date" required>
              <Input name="to" type="date" defaultValue={today(90)} required />
            </Field>
            <Button type="submit" name="format" value="csv" disabled={loading}>
              Export CSV
            </Button>
            <Button type="submit" name="format" value="pdf" disabled={loading}>
              Print schedule / Save PDF
            </Button>
          </form>
          <details className="schedule-details">
            <summary>Create a recurring weekly event</summary>
            <form
              className="schedule-form"
              onSubmit={(event) => void createSeries(event)}
            >
              <Field label="Title" required>
                <Input name="title" required />
              </Field>
              <Field label="Kind">
                <Select
                  name="kind"
                  options={['practice', 'game', 'meet', 'class_session']}
                />
              </Field>
              <Field label="First date" required>
                <Input
                  name="startsOn"
                  type="date"
                  defaultValue={today()}
                  required
                />
              </Field>
              <Field label="Last date" required>
                <Input
                  name="endsOn"
                  type="date"
                  defaultValue={today(90)}
                  required
                />
              </Field>
              <Field label="Weekday">
                <Select
                  name="weekday"
                  options={[
                    { value: 'MO', label: 'Monday' },
                    { value: 'TU', label: 'Tuesday' },
                    { value: 'WE', label: 'Wednesday' },
                    { value: 'TH', label: 'Thursday' },
                    { value: 'FR', label: 'Friday' },
                    { value: 'SA', label: 'Saturday' },
                    { value: 'SU', label: 'Sunday' },
                  ]}
                />
              </Field>
              <Field label="Start time">
                <Input
                  name="startTime"
                  type="time"
                  defaultValue="18:00"
                  required
                />
              </Field>
              <Field label="Duration (minutes)">
                <Input
                  name="durationMinutes"
                  type="number"
                  min={5}
                  max={720}
                  defaultValue={60}
                  required
                />
              </Field>
              <Field label="Timezone">
                <Input
                  value={timezone}
                  onChange={(event) => {
                    setTimezone(event.target.value);
                  }}
                  required
                />
              </Field>
              <Field label="Program ID">
                <Input name="programId" />
              </Field>
              <Field label="Division ID">
                <Input name="divisionId" />
              </Field>
              <Field label="Space ID">
                <Input name="spaceId" />
              </Field>
              <Field label="Location">
                <Input name="locationText" />
              </Field>
              <Field
                label="Soft conflict override reason"
                hint="Only used if the server reports an overridable team, coach, or official conflict. Space conflicts cannot be overridden."
              >
                <Input
                  name="seriesOverrideReason"
                  minLength={10}
                  maxLength={500}
                />
              </Field>
              <Button type="submit" disabled={loading}>
                Create weekly series
              </Button>
            </form>
          </details>
          <details className="schedule-details">
            <summary>Edit this, following, or all series events</summary>
            <form
              className="schedule-form"
              onSubmit={(event) => void editSeries(event)}
            >
              <Field label="Series ID" required>
                <Input
                  value={seriesId}
                  onChange={(event) => {
                    setSeriesId(event.target.value);
                  }}
                  required
                />
              </Field>
              <Field label="Series version" required>
                <Input
                  name="seriesVersion"
                  type="number"
                  min={1}
                  defaultValue={1}
                  required
                />
              </Field>
              <Field label="Occurrence start (local)" required>
                <Input
                  name="occurrenceStartsAt"
                  type="datetime-local"
                  required
                />
              </Field>
              <Field label="Edit scope">
                <Select name="scope" options={['this', 'following', 'all']} />
              </Field>
              <Field label="New title">
                <Input name="title" />
              </Field>
              <Field label="This event: new start">
                <Input name="newStartsAt" type="datetime-local" />
              </Field>
              <Field label="This event: new end">
                <Input name="newEndsAt" type="datetime-local" />
              </Field>
              <Field label="Future series start date">
                <Input name="startsOn" type="date" defaultValue={today()} />
              </Field>
              <Field label="Future series end date">
                <Input name="endsOn" type="date" defaultValue={today(90)} />
              </Field>
              <Field label="Future series weekday">
                <Select
                  name="weekday"
                  options={['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']}
                />
              </Field>
              <Field label="Future series start time">
                <Input
                  name="seriesStartTime"
                  type="time"
                  defaultValue="18:00"
                />
              </Field>
              <Field label="Future series duration">
                <Input
                  name="seriesDuration"
                  type="number"
                  min={5}
                  max={720}
                  defaultValue={60}
                />
              </Field>
              <Field
                label="Soft conflict override reason"
                hint="Only used if the server reports an overridable team, coach, or official conflict. Space conflicts cannot be overridden."
              >
                <Input
                  name="seriesOverrideReason"
                  minLength={10}
                  maxLength={500}
                />
              </Field>
              <Button type="submit" disabled={loading || !seriesId}>
                Save series edit
              </Button>
            </form>
          </details>
          <form
            className="schedule-form schedule-form--two"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void perform(async () => {
                await api(
                  `${base(orgId, 'scheduling')}/games/bulk-shift`,
                  json({
                    fromDate: formText(form, 'fromDate'),
                    toDate: formText(form, 'toDate'),
                    timezone,
                    ...(formText(form, 'overrideReason').trim()
                      ? {
                          overrideReason: formText(
                            form,
                            'overrideReason',
                          ).trim(),
                        }
                      : {}),
                  }),
                );
                await loadEvents();
              }, 'Games shifted.');
            }}
          >
            <Field label="Move games from" required>
              <Input name="fromDate" type="date" required />
            </Field>
            <Field label="Move games to" required>
              <Input name="toDate" type="date" required />
            </Field>
            <Field label="Soft conflict override reason">
              <Input name="overrideReason" minLength={10} maxLength={500} />
            </Field>
            <Button type="submit" disabled={loading}>
              Move games
            </Button>
          </form>
          <form
            className="schedule-form schedule-form--two"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const scopeType = formText(form, 'scopeType');
              const scopeId = formText(form, 'scopeId') || null;
              const startsAt = localInstant(
                formText(form, 'startsAt'),
                timezone,
              );
              const endsAt = localInstant(formText(form, 'endsAt'), timezone);
              const closure = {
                scopeType,
                scopeId,
                startsAt,
                endsAt,
                reason: formText(form, 'reason'),
                message: formText(form, 'message') || null,
              };
              void perform(async () => {
                const preview = await api<{
                  count: number;
                  events: Array<{ id: string; title: string }>;
                }>(
                  `${base(orgId, 'scheduling')}/closures/preview`,
                  json(closure),
                );
                if (
                  !window.confirm(
                    `Close this schedule window and postpone ${String(preview.count)} affected events?`,
                  )
                )
                  return;
                await api(
                  `${base(orgId, 'scheduling')}/closures`,
                  json(closure),
                );
                await loadEvents();
              }, 'Closure recorded and affected events updated.');
            }}
          >
            <Field label="Closure scope">
              <Select name="scopeType" options={['org', 'facility', 'space']} />
            </Field>
            <Field label="Facility or space ID">
              <Input name="scopeId" />
            </Field>
            <Field label="Starts" required>
              <Input name="startsAt" type="datetime-local" required />
            </Field>
            <Field label="Ends" required>
              <Input name="endsAt" type="datetime-local" required />
            </Field>
            <Field label="Reason">
              <Select
                name="reason"
                options={['weather', 'maintenance', 'permit', 'other']}
              />
            </Field>
            <Field label="Portal message">
              <Input name="message" maxLength={500} />
            </Field>
            <Button type="submit" disabled={loading}>
              Preview and close
            </Button>
          </form>
        </section>
      </div>

      <section
        className="schedule-card"
        aria-labelledby="schedule-results-heading"
      >
        <div className="schedule-card__title">
          <div>
            <h2 id="schedule-results-heading">Results workflow</h2>
            <p>
              {selected
                ? `${selected.title} · ${new Date(selected.startsAt).toLocaleString()}`
                : 'Select an event above.'}
            </p>
          </div>
          <Select
            aria-label="Selected event"
            value={selectedEvent}
            onChange={(event) => {
              setSelectedEvent(event.target.value);
              setContest(null);
            }}
          >
            <option value="">Select event</option>
            {events.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </Select>
        </div>
        <div className="schedule-actions">
          <Button
            secondary
            disabled={!selectedEvent || loading}
            onClick={() => void perform(loadContest, 'Contest loaded.')}
          >
            Load contest
          </Button>
          <Button
            disabled={!selectedEvent || loading}
            onClick={() =>
              void perform(
                createContestForEvent,
                'Contest created. Choose its sport-specific result format below.',
              )
            }
          >
            Create contest · first sport format
          </Button>
        </div>
        {contest && (
          <div className="schedule-run">
            <div className="schedule-card__title">
              <strong>
                {contest.format?.format ?? 'Contest'} · {contest.id}
              </strong>
              <Badge tone={contest.status === 'final' ? 'ok' : 'pending'}>
                {contest.status}
              </Badge>
            </div>
            {contest.format?.format === 'multi_timed' &&
              !!contest.participants?.length &&
              ['scheduled', 'in_progress'].includes(contest.status) && (
                <form
                  key={`meet-${String(contest.version)}`}
                  className="schedule-card"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const assignments = contest.participants?.map(
                      (participant, index) => ({
                        participantId: participant.id,
                        seed: Number(
                          form.get(`seed-${participant.id}`) ?? index + 1,
                        ),
                        heat: Number(form.get(`heat-${participant.id}`) ?? 1),
                        lane: Number(
                          form.get(`lane-${participant.id}`) ?? index + 1,
                        ),
                      }),
                    );
                    void perform(async () => {
                      await api(
                        `${base(orgId, 'contests')}/contests/${contest.id}/meet-assignments`,
                        {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            expectedVersion: contest.version,
                            assignments,
                          }),
                        },
                      );
                      await loadContest();
                    }, 'Meet heats and lanes saved.');
                  }}
                >
                  <h3>Meet heat and lane assignments</h3>
                  <div className="table-scroll">
                    <table className="ui-table">
                      <thead>
                        <tr>
                          <th scope="col">Participant</th>
                          <th scope="col">Seed</th>
                          <th scope="col">Heat</th>
                          <th scope="col">Lane</th>
                        </tr>
                      </thead>
                      <tbody>
                        {contest.participants.map((participant, index) => {
                          const label =
                            participant.person_id ??
                            participant.team_season_id ??
                            participant.external_team_id ??
                            participant.id;
                          return (
                            <tr key={participant.id}>
                              <th scope="row">{label}</th>
                              <td>
                                <Input
                                  aria-label={`Seed for ${label}`}
                                  name={`seed-${participant.id}`}
                                  type="number"
                                  min={1}
                                  required
                                  defaultValue={participant.seed ?? index + 1}
                                />
                              </td>
                              <td>
                                <Input
                                  aria-label={`Heat for ${label}`}
                                  name={`heat-${participant.id}`}
                                  type="number"
                                  min={1}
                                  required
                                  defaultValue={participant.heat ?? 1}
                                />
                              </td>
                              <td>
                                <Input
                                  aria-label={`Lane for ${label}`}
                                  name={`lane-${participant.id}`}
                                  type="number"
                                  min={1}
                                  max={contest.format?.lanes}
                                  required
                                  defaultValue={participant.lane ?? index + 1}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Button type="submit" disabled={loading}>
                    Save meet assignments
                  </Button>
                </form>
              )}
            <form
              className="schedule-form"
              onSubmit={(event) => void submitResult(event)}
            >
              <Field
                label="Format-specific result JSON"
                hint='Examples: {"home":3,"away":1}, {"sets":[{"home":25,"away":18}]}, or {"entries":[...]}. The server validates against this sport profile.'
                required
              >
                <Textarea
                  name="resultJson"
                  rows={5}
                  defaultValue={
                    contest.format?.format === 'multi_timed'
                      ? JSON.stringify(
                          {
                            entries: (contest.participants ?? []).map(
                              (participant) => ({
                                participantId: participant.id,
                                value: 0,
                              }),
                            ),
                          },
                          null,
                          2,
                        )
                      : '{\n  "home": 0,\n  "away": 0\n}'
                  }
                />
              </Field>
              {contest.statDefinitions?.flatMap((definition) =>
                (contest.participants ?? [])
                  .filter((participant) =>
                    definition.level === 'athlete'
                      ? participant.person_id !== null
                      : participant.team_season_id !== null,
                  )
                  .map((participant) => {
                    const participantLabel =
                      participant.person_id ??
                      participant.team_season_id ??
                      participant.id;
                    const label =
                      definition.label[
                        document.documentElement.lang === 'es' ? 'es' : 'en'
                      ] || definition.abbreviation;
                    return (
                      <Field
                        key={`${participant.id}:${definition.key}`}
                        label={`${label} · ${participantLabel}`}
                      >
                        <Input
                          aria-label={`${label} for ${participantLabel}`}
                          name={`stat:${participant.id}:${definition.key}`}
                          type="number"
                          min={0}
                          step={definition.valueType === 'integer' ? 1 : 'any'}
                        />
                      </Field>
                    );
                  }),
              )}
              <label className="schedule-check">
                <input name="finalize" type="checkbox" /> Finalize result and
                update standings
              </label>
              <Button type="submit" disabled={loading}>
                Submit result
              </Button>
            </form>
            {contest.results?.length ? (
              <div className="schedule-actions" aria-label="Result exports">
                <Button
                  secondary
                  onClick={() => {
                    exportContestResults('csv');
                  }}
                >
                  Export results CSV
                </Button>
                <Button
                  secondary
                  onClick={() => {
                    exportContestResults('pdf');
                  }}
                >
                  Print results / Save PDF
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <div className="schedule-grid">
        <section
          className="schedule-card"
          aria-labelledby="schedule-facilities-heading"
        >
          <h2 id="schedule-facilities-heading">Facilities</h2>
          <ul className="schedule-facility-list">
            {facilities.map((facility) => (
              <li key={facility.id}>
                <strong>{facility.name}</strong>
                <small>
                  {facility.timezone ?? 'Timezone not set'} ·{' '}
                  {facility.public ? 'Public listing enabled' : 'Private'}
                </small>
              </li>
            ))}
            {!facilities.length && <li>No facilities yet.</li>}
          </ul>
          <h3>Bookable spaces</h3>
          <ul className="schedule-facility-list">
            {spaces.map((space) => (
              <li key={space.id}>
                <strong>{space.name}</strong>
                <small>
                  {space.kind} ·{' '}
                  {facilities.find(
                    (facility) => facility.id === space.facility_id,
                  )?.name ?? 'Facility'}
                  {space.parent_space_id ? ' · split space' : ''}
                </small>
              </li>
            ))}
            {!spaces.length && <li>No bookable spaces yet.</li>}
          </ul>
          <form
            className="schedule-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void perform(async () => {
                await api(
                  `${base(orgId, 'scheduling')}/facilities`,
                  json({
                    name: formText(form, 'name'),
                    address: null,
                    timezone: formText(form, 'facilityTimezone'),
                    ownership: formText(form, 'ownership'),
                    parkingNotes: formText(form, 'parkingNotes') || null,
                    isPublic: form.get('isPublic') === 'on',
                  }),
                );
                await loadFacilities();
                await loadSpaces();
              }, 'Facility created.');
            }}
          >
            <Field label="Facility name" required>
              <Input name="name" required maxLength={160} />
            </Field>
            <Field label="Facility timezone" required>
              <Input name="facilityTimezone" defaultValue={timezone} required />
            </Field>
            <Field label="Ownership">
              <Select
                name="ownership"
                options={['owned', 'permitted', 'partner']}
              />
            </Field>
            <Field label="Parking notes">
              <Textarea name="parkingNotes" rows={2} maxLength={2000} />
            </Field>
            <label className="schedule-check">
              <input name="isPublic" type="checkbox" /> List publicly
            </label>
            <Button type="submit" disabled={loading}>
              Add facility
            </Button>
          </form>
          <details className="schedule-details">
            <summary>Add a bookable space</summary>
            <form
              className="schedule-form schedule-form--two"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void perform(async () => {
                  const parentSpaceId = formText(form, 'parentSpaceId');
                  await api(
                    `${base(orgId, 'scheduling')}/spaces`,
                    json({
                      facilityId: formText(form, 'facilityId'),
                      ...(parentSpaceId ? { parentSpaceId } : {}),
                      name: formText(form, 'spaceName'),
                      kind: formText(form, 'spaceKind'),
                      surface: formText(form, 'surface') || null,
                      hasLights: form.get('hasLights') === 'on',
                    }),
                  );
                  await loadSpaces();
                }, 'Bookable space created.');
              }}
            >
              <Field label="Facility" required>
                <Select
                  name="facilityId"
                  required
                  options={facilities.map((facility) => ({
                    value: facility.id,
                    label: facility.name,
                  }))}
                />
              </Field>
              <Field label="Parent space">
                <Select
                  name="parentSpaceId"
                  options={[
                    { value: '', label: 'Standalone space' },
                    ...spaces.map((space) => ({
                      value: space.id,
                      label: space.name,
                    })),
                  ]}
                />
              </Field>
              <Field label="Space name" required>
                <Input name="spaceName" required maxLength={120} />
              </Field>
              <Field label="Space type" required>
                <Select
                  name="spaceKind"
                  options={[
                    'field',
                    'court',
                    'rink',
                    'pool',
                    'lanes',
                    'mat',
                    'diamond',
                    'track',
                    'room',
                    'other',
                  ]}
                />
              </Field>
              <Field label="Surface">
                <Input name="surface" maxLength={80} />
              </Field>
              <label className="schedule-check">
                <input name="hasLights" type="checkbox" /> Has lights
              </label>
              <Button type="submit" disabled={loading || !facilities.length}>
                Add space
              </Button>
            </form>
          </details>
          <details className="schedule-details">
            <summary>Set weekly space availability</summary>
            <form
              className="schedule-form schedule-form--two"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void perform(async () => {
                  const space = spaces.find(
                    (item) => item.id === formText(form, 'availabilitySpaceId'),
                  );
                  const facility = facilities.find(
                    (item) => item.id === space?.facility_id,
                  );
                  if (!space || !facility)
                    throw new Error('Choose a known space and facility.');
                  const dayCode = weekdayForDate(
                    formText(form, 'availabilityWeekday'),
                  );
                  await api(
                    `${base(orgId, 'scheduling')}/space-availability`,
                    json({
                      spaceId: space.id,
                      recurrence: {
                        kind: 'weekly',
                        interval: 1,
                        byDay: [dayCode],
                        startsOn: formText(form, 'availabilityStartsOn'),
                        endsOn: formText(form, 'availabilityEndsOn'),
                        exceptions: [],
                        additions: [],
                      },
                      startsOn: formText(form, 'availabilityStartsOn'),
                      endsOn: formText(form, 'availabilityEndsOn'),
                      startTime: formText(form, 'availabilityStartTime'),
                      endTime: formText(form, 'availabilityEndTime'),
                      timezone: facility.timezone ?? timezone,
                      source: formText(form, 'availabilitySource'),
                      permitReference:
                        formText(form, 'permitReference') || null,
                    }),
                  );
                }, 'Space availability saved.');
              }}
            >
              <Field label="Space" required>
                <Select
                  name="availabilitySpaceId"
                  required
                  options={spaces.map((space) => ({
                    value: space.id,
                    label: space.name,
                  }))}
                />
              </Field>
              <Field label="Available weekday" required>
                <Input
                  name="availabilityWeekday"
                  type="date"
                  required
                  defaultValue={today()}
                />
              </Field>
              <Field label="Starts on" required>
                <Input
                  name="availabilityStartsOn"
                  type="date"
                  required
                  defaultValue={today()}
                />
              </Field>
              <Field label="Ends on" required>
                <Input
                  name="availabilityEndsOn"
                  type="date"
                  required
                  defaultValue={today(90)}
                />
              </Field>
              <Field label="Start time" required>
                <Input
                  name="availabilityStartTime"
                  type="time"
                  required
                  defaultValue="08:00"
                />
              </Field>
              <Field label="End time" required>
                <Input
                  name="availabilityEndTime"
                  type="time"
                  required
                  defaultValue="20:00"
                />
              </Field>
              <Field label="Availability source">
                <Select
                  name="availabilitySource"
                  options={['owned', 'permit']}
                />
              </Field>
              <Field label="Permit reference">
                <Input name="permitReference" maxLength={200} />
              </Field>
              <Button type="submit" disabled={loading || !spaces.length}>
                Save availability
              </Button>
            </form>
          </details>
          <details className="schedule-details">
            <summary>Allocate recurring practice or game time</summary>
            <form
              className="schedule-form schedule-form--two"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void perform(async () => {
                  const space = spaces.find(
                    (item) => item.id === formText(form, 'allocationSpaceId'),
                  );
                  const facility = facilities.find(
                    (item) => item.id === space?.facility_id,
                  );
                  if (!space || !facility)
                    throw new Error('Choose a known space and facility.');
                  const teamSeasonId = formText(form, 'allocationTeamSeasonId');
                  const allocationDivisionId = formText(
                    form,
                    'allocationDivisionId',
                  );
                  if (Boolean(teamSeasonId) === Boolean(allocationDivisionId))
                    throw new Error(
                      'Choose exactly one team season or division.',
                    );
                  const startsOn = formText(form, 'allocationStartsOn');
                  const endsOn = formText(form, 'allocationEndsOn');
                  await api(
                    `${base(orgId, 'scheduling')}/allocations`,
                    json({
                      spaceId: space.id,
                      ...(teamSeasonId ? { teamSeasonId } : {}),
                      ...(allocationDivisionId
                        ? { divisionId: allocationDivisionId }
                        : {}),
                      recurrence: {
                        kind: 'weekly',
                        interval: 1,
                        byDay: [
                          weekdayForDate(formText(form, 'allocationWeekday')),
                        ],
                        startsOn,
                        endsOn,
                        exceptions: [],
                        additions: [],
                      },
                      startsOn,
                      endsOn,
                      startTime: formText(form, 'allocationStartTime'),
                      endTime: formText(form, 'allocationEndTime'),
                      timezone: facility.timezone ?? timezone,
                      purpose: formText(form, 'allocationPurpose'),
                    }),
                  );
                }, 'Recurring allocation created.');
              }}
            >
              <Field label="Space" required>
                <Select
                  name="allocationSpaceId"
                  required
                  options={spaces.map((space) => ({
                    value: space.id,
                    label: space.name,
                  }))}
                />
              </Field>
              <Field label="Team season ID">
                <Input name="allocationTeamSeasonId" />
              </Field>
              <Field label="Division ID">
                <Input name="allocationDivisionId" />
              </Field>
              <Field label="Weekday" required>
                <Input
                  name="allocationWeekday"
                  type="date"
                  required
                  defaultValue={today()}
                />
              </Field>
              <Field label="Starts on" required>
                <Input
                  name="allocationStartsOn"
                  type="date"
                  required
                  defaultValue={today()}
                />
              </Field>
              <Field label="Ends on" required>
                <Input
                  name="allocationEndsOn"
                  type="date"
                  required
                  defaultValue={today(90)}
                />
              </Field>
              <Field label="Start time" required>
                <Input
                  name="allocationStartTime"
                  type="time"
                  required
                  defaultValue="17:00"
                />
              </Field>
              <Field label="End time" required>
                <Input
                  name="allocationEndTime"
                  type="time"
                  required
                  defaultValue="18:00"
                />
              </Field>
              <Field label="Purpose">
                <Select
                  name="allocationPurpose"
                  options={['practice', 'games', 'clinic', 'other']}
                />
              </Field>
              <Button type="submit" disabled={loading || !spaces.length}>
                Create allocation
              </Button>
            </form>
          </details>
          <form
            className="schedule-form schedule-form--two"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void perform(async () => {
                await api(`${base(orgId, 'scheduling')}/schedule-settings`, {
                  ...json({
                    programId,
                    coachSlotPickerEnabled:
                      form.get('slotPickerEnabled') === 'on',
                    slotApprovalRequired:
                      form.get('slotApprovalRequired') === 'on',
                  }),
                  method: 'PUT',
                });
              }, 'Schedule settings saved.');
            }}
          >
            <label className="schedule-check">
              <input name="slotPickerEnabled" type="checkbox" /> Let coaches
              request allocated practice slots
            </label>
            <label className="schedule-check">
              <input
                name="slotApprovalRequired"
                type="checkbox"
                defaultChecked
              />{' '}
              Require scheduler approval
            </label>
            <Button type="submit" disabled={loading || !programId}>
              Save slot-picker settings
            </Button>
          </form>
        </section>

        <section
          className="schedule-card"
          aria-labelledby="schedule-standings-heading"
        >
          <h2 id="schedule-standings-heading">Standings</h2>
          <p>Load or refresh a program or division snapshot.</p>
          <Field label="Standings scope">
            <Select
              value={standingsScopeType}
              options={['program', 'division']}
              onChange={(event) => {
                setStandingsScopeType(
                  event.target.value as 'program' | 'division',
                );
              }}
            />
          </Field>
          <Field label="Program or division ID">
            <Input
              value={
                standingsScopeId ||
                (standingsScopeType === 'program' ? programId : '')
              }
              onChange={(event) => {
                setStandingsScopeId(event.target.value);
              }}
            />
          </Field>
          <div className="schedule-actions">
            <Button
              secondary
              disabled={loading || !standingsScope().id}
              onClick={() => void loadStandings()}
            >
              Load standings
            </Button>
            <Button
              disabled={loading || !standingsScope().id}
              onClick={() => void refreshStandings()}
            >
              Refresh snapshot
            </Button>
            {standings && (
              <Button secondary disabled={loading} onClick={printStandings}>
                Print standings / Save PDF
              </Button>
            )}
          </div>
          {standings !== null && (
            <>
              <p>
                Visibility: {standings.config.publicVisibility} ·{' '}
                {(standings.computedAt ?? standings.computed_at)
                  ? `Updated ${new Date(standings.computedAt ?? standings.computed_at ?? '').toLocaleString()}`
                  : 'Calculated from current results'}
              </p>
              <form
                className="schedule-form"
                onSubmit={(event) => void saveStandingsVisibility(event)}
              >
                <Field label="Standings visibility">
                  <Select
                    name="publicVisibility"
                    options={['public', 'members', 'hidden']}
                    defaultValue={standings.config.publicVisibility}
                  />
                </Field>
                <Button type="submit" disabled={loading}>
                  Save visibility
                </Button>
              </form>
              <div
                className="table-scroll"
                role="region"
                aria-label="Standings table"
                tabIndex={0}
              >
                <table className="ui-table">
                  <thead>
                    <tr>
                      <th scope="col">Rank</th>
                      <th scope="col">Team</th>
                      <th scope="col">Played</th>
                      <th scope="col">W</th>
                      <th scope="col">L</th>
                      <th scope="col">T</th>
                      <th scope="col">Points</th>
                      <th scope="col">Scored</th>
                      <th scope="col">Allowed</th>
                      <th scope="col">Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {standings.rows.map((row) => (
                      <tr key={row.teamId}>
                        <td>{row.rank}</td>
                        <th scope="row">
                          {standings.teamNames[row.teamId] ?? row.teamId}
                        </th>
                        <td>{row.played}</td>
                        <td>{row.wins}</td>
                        <td>{row.losses}</td>
                        <td>{row.ties}</td>
                        <td>{row.points}</td>
                        <td>{row.scored}</td>
                        <td>{row.allowed}</td>
                        <td>{row.differential}</td>
                      </tr>
                    ))}
                    {!standings.rows.length && (
                      <tr>
                        <td colSpan={10}>No standings entries yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
        <section
          className="schedule-card"
          aria-labelledby="schedule-team-stats-heading"
        >
          <h2 id="schedule-team-stats-heading">Team statistics</h2>
          <form
            className="schedule-form"
            onSubmit={(event) => {
              event.preventDefault();
              void loadTeamStats();
            }}
          >
            <Field label="Team season ID" required>
              <Input
                value={teamStatsTeamId}
                onChange={(event) => {
                  setTeamStatsTeamId(event.target.value);
                }}
                required
              />
            </Field>
            <Button type="submit" disabled={loading || !teamStatsTeamId.trim()}>
              Load team statistics
            </Button>
          </form>
          {teamStats && (
            <div className="table-scroll">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th scope="col">Statistic</th>
                    <th scope="col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {teamStats.definitions.map((definition) => {
                    const value = teamStats.summary[definition.key] ?? 0;
                    return (
                      <tr key={definition.key}>
                        <th scope="row">
                          {definition.label[
                            document.documentElement.lang === 'es' ? 'es' : 'en'
                          ] || definition.abbreviation}
                        </th>
                        <td>
                          {definition.valueType === 'time_ms'
                            ? `${(value / 1000).toFixed(2)} s`
                            : value}
                        </td>
                      </tr>
                    );
                  })}
                  {!teamStats.definitions.length && (
                    <tr>
                      <td colSpan={2}>
                        No public team statistics are configured.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      <section
        className="schedule-card"
        aria-labelledby="schedule-stat-settings-heading"
      >
        <h2 id="schedule-stat-settings-heading">Program statistic settings</h2>
        <p>
          Choose which sport statistics can be entered for this program. Public
          athlete statistics appear in leaderboards and personal bests; private
          athlete statistics stay staff-only.
        </p>
        <div className="schedule-actions">
          <Button
            type="button"
            secondary
            disabled={loading || !programId.trim()}
            onClick={() => void loadProgramStatSettings()}
          >
            Load statistic settings
          </Button>
        </div>
        {programStatSettings && (
          <form
            className="schedule-form"
            onSubmit={(event) => void saveProgramStatSettings(event)}
          >
            {programStatSettings.definitions.map((definition) => {
              const enabled = programStatSettings.enabledStatKeys.includes(
                definition.key,
              );
              const label =
                definition.label[
                  document.documentElement.lang === 'es' ? 'es' : 'en'
                ] || definition.abbreviation;
              return (
                <label className="schedule-check" key={definition.key}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => {
                      const enabledStatKeys = new Set(
                        programStatSettings.enabledStatKeys,
                      );
                      if (event.currentTarget.checked)
                        enabledStatKeys.add(definition.key);
                      else enabledStatKeys.delete(definition.key);
                      setProgramStatSettings({
                        ...programStatSettings,
                        enabledStatKeys: [...enabledStatKeys],
                      });
                    }}
                  />
                  {label} ({definition.level}) ·{' '}
                  {definition.public ? 'public' : 'staff only'}
                </label>
              );
            })}
            {!programStatSettings.definitions.length && (
              <p>No statistics are defined in this sport profile.</p>
            )}
            <Button
              type="submit"
              disabled={loading || !programStatSettings.definitions.length}
            >
              Save statistic settings
            </Button>
          </form>
        )}
      </section>
      <section
        className="schedule-card"
        aria-labelledby="schedule-stat-leaderboards-heading"
      >
        <h2 id="schedule-stat-leaderboards-heading">
          Program and division leaderboards
        </h2>
        <p>Only configured statistics marked public are shown.</p>
        <Button
          type="button"
          disabled={loading || !programId.trim()}
          onClick={() => void loadProgramStatLeaders()}
        >
          Load leaderboards
        </Button>
        {programStatLeaders &&
          (programStatLeaders.items.length ? (
            programStatLeaders.items.map((item) => (
              <div className="table-scroll" key={item.key}>
                <h3>
                  {item.label[
                    document.documentElement.lang === 'es' ? 'es' : 'en'
                  ] || item.abbreviation}
                </h3>
                <table className="ui-table">
                  <thead>
                    <tr>
                      <th scope="col">Rank</th>
                      <th scope="col">
                        {item.level === 'athlete' ? 'Athlete' : 'Team'}
                      </th>
                      <th scope="col">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.leaders.map((leader) => (
                      <tr key={leader.subjectId}>
                        <td>{leader.rank}</td>
                        <th scope="row">{leader.subjectLabel}</th>
                        <td>
                          {item.valueType === 'time_ms'
                            ? `${(leader.value / 1000).toFixed(2)} s`
                            : leader.value}
                        </td>
                      </tr>
                    ))}
                    {!item.leaders.length && (
                      <tr>
                        <td colSpan={3}>No finalized results yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ))
          ) : (
            <p>No configured public statistics are available.</p>
          ))}
      </section>
      <ScheduleRequestsPanel orgId={orgId} />
      <TournamentPanel orgId={orgId} programId={programId} />
      <OfficialsPanel orgId={orgId} programId={programId} />
      <SeasonEndPanel orgId={orgId} programId={programId} />
    </main>
  );
}

type SurveyCampaign = {
  id: string;
  title: string;
  status: string;
  version: number;
};

function SeasonEndPanel({
  orgId,
  programId,
}: {
  orgId: string;
  programId: string;
}): React.JSX.Element {
  const [campaigns, setCampaigns] = useState<SurveyCampaign[]>([]);
  const [awards, setAwards] = useState<Array<Record<string, unknown>>>([]);
  const [results, setResults] = useState<Record<string, unknown> | null>(null);
  const [priorRatings, setPriorRatings] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [ratingVersion, setRatingVersion] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!programId) return;
    try {
      const [surveys, awardRows] = await Promise.all([
        api<{ items: SurveyCampaign[] }>(
          `${base(orgId, 'standings')}/programs/${programId}/season-surveys`,
        ),
        api<{ items: Array<Record<string, unknown>> }>(
          `${base(orgId, 'standings')}/programs/${programId}/season-awards`,
        ),
      ]);
      setCampaigns(surveys.items);
      setAwards(awardRows.items);
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Season-end operations could not be loaded.',
      );
    }
  }, [orgId, programId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<void>, success: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(success);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The season action failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  function printAwards(): void {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setError('Allow the certificate window to open, then try again.');
      return;
    }
    const document = printWindow.document;
    document.title = 'Season award certificates';
    const style = document.createElement('style');
    style.textContent =
      '@page{size:letter landscape;margin:18mm}body{font-family:system-ui,sans-serif;color:#111}article{min-height:165mm;box-sizing:border-box;border:2px solid #111;padding:28mm;text-align:center;display:flex;flex-direction:column;justify-content:center;page-break-after:always}h1{font-size:32pt}h2{font-size:22pt}p{font-size:14pt}';
    document.head.replaceChildren(style);
    const cards = awards.map((award) => {
      const article = document.createElement('article');
      const brand = document.createElement('p');
      brand.textContent = 'Athlentry · Season Award';
      const recipient = document.createElement('h1');
      recipient.textContent = awardRecipientLabel(award);
      const title = document.createElement('h2');
      title.textContent =
        typeof award.title === 'string' ? award.title : 'Season Award';
      const description = document.createElement('p');
      description.textContent =
        typeof award.description === 'string' ? award.description : '';
      article.append(brand, recipient, title, description);
      return article;
    });
    document.body.replaceChildren(...cards);
    window.setTimeout(() => {
      printWindow.print();
    }, 100);
  }

  return (
    <section className="schedule-card" aria-labelledby="season-end-heading">
      <h2 id="season-end-heading">Season end</h2>
      <p>
        Create family surveys, capture player ratings, issue awards, and archive
        completed seasons.
      </p>
      {(error || message) && (
        <p role={error ? 'alert' : 'status'}>{error || message}</p>
      )}
      <form
        className="schedule-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void act(async () => {
            await api(
              `${base(orgId, 'standings')}/programs/${programId}/season-surveys`,
              json({
                title: formText(form, 'surveyTitle'),
                locale: formText(form, 'surveyLocale'),
              }),
            );
          }, 'Family survey created.');
        }}
      >
        <Field label="Family survey title" required>
          <Input name="surveyTitle" required maxLength={200} />
        </Field>
        <Field label="Family survey language">
          <Select name="surveyLocale" options={['en', 'es']} />
        </Field>
        <Button type="submit" disabled={busy || !programId}>
          Create survey
        </Button>
      </form>
      <div className="schedule-run-list">
        {campaigns.map((campaign) => (
          <article className="schedule-run" key={campaign.id}>
            <div className="schedule-card__title">
              <strong>{campaign.title}</strong>
              <Badge tone={campaign.status === 'open' ? 'ok' : 'pending'}>
                {campaign.status}
              </Badge>
            </div>
            <code>{campaign.id}</code>
            <div className="schedule-actions">
              {campaign.status !== 'archived' &&
                campaign.status !== 'closed' && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const status =
                          campaign.status === 'draft' ? 'open' : 'closed';
                        await api(
                          `${base(orgId, 'standings')}/season-surveys/${campaign.id}`,
                          {
                            ...json({
                              status,
                              expectedVersion: campaign.version,
                            }),
                            method: 'PATCH',
                          },
                        );
                      }, 'Survey status updated.')
                    }
                  >
                    {campaign.status === 'draft'
                      ? 'Open survey'
                      : 'Close survey'}
                  </Button>
                )}
              {campaign.status === 'closed' && (
                <>
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        setResults(
                          await api<Record<string, unknown>>(
                            `${base(orgId, 'standings')}/season-surveys/${campaign.id}/results`,
                          ),
                        );
                      }, 'Survey results loaded.')
                    }
                  >
                    View results
                  </Button>
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api(
                          `${base(orgId, 'standings')}/season-surveys/${campaign.id}`,
                          {
                            ...json({
                              status: 'archived',
                              expectedVersion: campaign.version,
                            }),
                            method: 'PATCH',
                          },
                        );
                      }, 'Survey archived.')
                    }
                  >
                    Archive survey
                  </Button>
                </>
              )}
            </div>
          </article>
        ))}
        {!campaigns.length && (
          <p>No family surveys created for this program.</p>
        )}
      </div>
      {results && (
        <pre className="schedule-json">{JSON.stringify(results, null, 2)}</pre>
      )}
      <h3>Issue an award</h3>
      <form
        className="schedule-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const personId = formText(form, 'awardPersonId').trim();
          const teamSeasonId = formText(form, 'awardTeamSeasonId').trim();
          void act(async () => {
            await api(
              `${base(orgId, 'standings')}/programs/${programId}/season-awards`,
              json({
                title: formText(form, 'awardTitle'),
                ...(personId ? { personId } : {}),
                ...(teamSeasonId ? { teamSeasonId } : {}),
              }),
            );
          }, 'Award issued.');
        }}
      >
        <Field label="Award title" required>
          <Input name="awardTitle" required maxLength={200} />
        </Field>
        <Field label="Person ID">
          <Input name="awardPersonId" />
        </Field>
        <Field label="Team season ID">
          <Input name="awardTeamSeasonId" />
        </Field>
        <Button type="submit" disabled={busy || !programId}>
          Issue award
        </Button>
      </form>
      {!!awards.length && (
        <>
          <div className="schedule-actions">
            <Button secondary disabled={busy} onClick={printAwards}>
              Print certificates / Save PDF
            </Button>
          </div>
          <ul className="schedule-run-list">
            {awards.map((award) => (
              <li className="schedule-run" key={String(award.id)}>
                <strong>{String(award.title)}</strong> ·{' '}
                {awardRecipientLabel(award)}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Capture a coach player rating</h3>
      <Button
        secondary
        disabled={busy || !programId}
        onClick={() =>
          void act(async () => {
            setPriorRatings(
              await api<Record<string, unknown>>(
                `${base(orgId, 'standings')}/programs/${programId}/prior-player-ratings`,
              ),
            );
          }, 'Prior-season ratings loaded.')
        }
      >
        Load prior-season ratings for balancing
      </Button>
      {priorRatings && (
        <pre className="schedule-json">
          {JSON.stringify(priorRatings, null, 2)}
        </pre>
      )}
      <form
        className="schedule-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void act(async () => {
            const saved = await api<{ version: number }>(
              `${base(orgId, 'standings')}/team-seasons/${formText(form, 'ratingTeamId')}/player-ratings`,
              {
                ...json({
                  personId: formText(form, 'ratingPersonId'),
                  rating: Number(form.get('rating')),
                  returningNextSeason: form.get('returning') === 'on',
                  ...(ratingVersion === null
                    ? {}
                    : { expectedVersion: ratingVersion }),
                }),
                method: 'PUT',
              },
            );
            setRatingVersion(saved.version);
          }, 'Player rating saved.');
        }}
      >
        <Field label="Team season ID" required>
          <Input
            name="ratingTeamId"
            required
            onChange={() => {
              setRatingVersion(null);
            }}
          />
        </Field>
        <Field label="Player ID" required>
          <Input
            name="ratingPersonId"
            required
            onChange={() => {
              setRatingVersion(null);
            }}
          />
        </Field>
        <Field label="Rating (1–5)" required>
          <Input name="rating" type="number" min={1} max={5} required />
        </Field>
        <label className="schedule-check">
          <input name="returning" type="checkbox" /> Returning next season
        </label>
        <Button type="submit" disabled={busy}>
          Save rating
        </Button>
      </form>
      <h3>Archive a completed season</h3>
      <form
        className="schedule-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void act(async () => {
            await api(
              `${base(orgId, 'standings')}/seasons/${formText(form, 'seasonId')}/archive`,
              {
                ...json({ expectedVersion: Number(form.get('seasonVersion')) }),
                method: 'POST',
              },
            );
          }, 'Season archived.');
        }}
      >
        <Field label="Season ID" required>
          <Input name="seasonId" required />
        </Field>
        <Field label="Season version" required>
          <Input name="seasonVersion" type="number" min={1} required />
        </Field>
        <Button type="submit" secondary disabled={busy}>
          Archive season
        </Button>
      </form>
    </section>
  );
}

type PendingReschedule = {
  id: string;
  version: number;
  reason: string;
  title: string;
  starts_at: string;
  proposed_slots: Array<{ startsAt: string; endsAt: string }>;
};
type PendingAllocation = {
  id: string;
  version: number;
  starts_at: string;
  ends_at: string;
  space_id: string;
  team_season_id: string | null;
};

function ScheduleRequestsPanel({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const [reschedules, setReschedules] = useState<PendingReschedule[]>([]);
  const [allocations, setAllocations] = useState<PendingAllocation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError('');
    try {
      const [rescheduleResult, allocationResult] = await Promise.all([
        api<{ items: PendingReschedule[] }>(
          `${base(orgId, 'scheduling')}/reschedule-requests`,
        ),
        api<{ items: PendingAllocation[] }>(
          `${base(orgId, 'scheduling')}/allocation-requests`,
        ),
      ]);
      setReschedules(rescheduleResult.items);
      setAllocations(allocationResult.items);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not load pending schedule requests.',
      );
    }
  }, [orgId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function decide(
    path: string,
    request: { id: string; version: number },
    approve: boolean,
    slotIndex?: number,
  ): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await api(
        `${base(orgId, 'scheduling')}/${path}/${request.id}/decision`,
        json({
          approve,
          expectedVersion: request.version,
          ...(slotIndex === undefined ? {} : { slotIndex }),
        }),
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Request could not be decided.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="schedule-card"
      aria-labelledby="schedule-requests-heading"
    >
      <div className="schedule-card__title">
        <div>
          <h2 id="schedule-requests-heading">Scheduler requests</h2>
          <p>Review proposed event moves and allocated practice slots.</p>
        </div>
        <Button secondary onClick={() => void load()}>
          Refresh requests
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      <h3>Reschedule requests</h3>
      {reschedules.map((request) => (
        <article className="schedule-run" key={request.id}>
          <strong>{request.title}</strong>
          <p>{request.reason}</p>
          <ul>
            {request.proposed_slots.map((slot) => (
              <li key={`${slot.startsAt}-${slot.endsAt}`}>
                {new Date(slot.startsAt).toLocaleString()} –{' '}
                {new Date(slot.endsAt).toLocaleTimeString()}
              </li>
            ))}
          </ul>
          <div className="schedule-actions">
            <Button
              disabled={busy || !request.proposed_slots.length}
              onClick={() =>
                void decide('reschedule-requests', request, true, 0)
              }
            >
              Approve proposed slot
            </Button>
            <Button
              secondary
              disabled={busy}
              onClick={() => void decide('reschedule-requests', request, false)}
            >
              Decline
            </Button>
          </div>
        </article>
      ))}
      {!reschedules.length && <p>No open reschedule requests.</p>}
      <h3>Allocated practice slot requests</h3>
      {allocations.map((request) => (
        <article className="schedule-run" key={request.id}>
          <p>
            {new Date(request.starts_at).toLocaleString()} –{' '}
            {new Date(request.ends_at).toLocaleTimeString()} · space{' '}
            {request.space_id.slice(0, 8)}
            {request.team_season_id
              ? ` · team ${request.team_season_id.slice(0, 8)}`
              : ''}
          </p>
          <div className="schedule-actions">
            <Button
              disabled={busy}
              onClick={() => void decide('allocation-requests', request, true)}
            >
              Approve slot
            </Button>
            <Button
              secondary
              disabled={busy}
              onClick={() => void decide('allocation-requests', request, false)}
            >
              Decline
            </Button>
          </div>
        </article>
      ))}
      {!allocations.length && <p>No pending allocated slot requests.</p>}
    </section>
  );
}

type BracketView = {
  bracket: {
    id: string;
    name: string;
    status: string;
    type: string;
    version: number;
  };
  entries: Array<{
    id: string;
    version: number;
    seed: number | null;
    status: string;
    team_season_id: string | null;
    external_team_id: string | null;
  }>;
  matches: Array<{
    id: string;
    round: number;
    position: number;
    version: number;
    contest_id: string | null;
    participant_a: unknown;
    participant_b: unknown;
  }>;
  pools: Array<{
    id: string;
    name: string;
    standings: Array<{
      teamId: string;
      rank: number;
      played: number;
      wins: number;
      losses: number;
      ties: number;
      points: number;
      differential: number;
    }>;
  }>;
  reservations: Array<{
    id: string;
    slot_type: 'pool' | 'bracket';
    round_index: number;
    position: number;
    bracket_match_id: string | null;
    title: string;
    starts_at: string;
    ends_at: string;
    timezone: string;
    space_id: string | null;
    status: string;
    published: boolean;
  }>;
};

function TournamentPanel({
  orgId,
  programId,
}: {
  orgId: string;
  programId: string;
}): React.JSX.Element {
  const [bracketId, setBracketId] = useState('');
  const [bracket, setBracket] = useState<BracketView | null>(null);
  const [seedResult, setSeedResult] = useState<unknown>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function loadBracket(id = bracketId): Promise<void> {
    const result = await api<BracketView>(
      `${base(orgId, 'tournaments')}/brackets/${encodeURIComponent(id)}`,
    );
    setBracket(result);
    setBracketId(result.bracket.id);
  }
  async function submitBracket(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    let entries: unknown;
    try {
      entries = JSON.parse(formText(form, 'entries'));
    } catch {
      setError('Enter tournament entries as valid JSON.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const created = await api<{ id: string }>(
        `${base(orgId, 'tournaments')}/brackets`,
        json({
          programId,
          ...(formText(form, 'divisionId').trim()
            ? { divisionId: formText(form, 'divisionId').trim() }
            : {}),
          name: formText(form, 'name'),
          type: formText(form, 'type'),
          seedingSource: 'manual',
          thirdPlace: form.get('thirdPlace') === 'on',
          entries,
        }),
      );
      await loadBracket(created.id);
      setMessage('Tournament created.');
      formElement.reset();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Tournament could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function mutate(
    action: () => Promise<void>,
    success: string,
  ): Promise<void> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Tournament action failed.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="schedule-card" aria-labelledby="tournament-heading">
      <h2 id="tournament-heading">Tournaments and brackets</h2>
      <p>
        Create a bracket, seed teams, check them in, and connect bracket matches
        to scheduled contests.
      </p>
      {(error || message) && (
        <p role={error ? 'alert' : 'status'}>{error || message}</p>
      )}
      <form
        className="schedule-form"
        onSubmit={(event) => void submitBracket(event)}
      >
        <Field label="Tournament name" required>
          <Input name="name" required maxLength={160} />
        </Field>
        <Field label="Division ID">
          <Input name="divisionId" />
        </Field>
        <Field label="Format">
          <Select
            name="type"
            options={[
              'single_elim',
              'double_elim',
              'round_robin_pools',
              'pools_to_bracket',
              'consolation',
              'ladder',
            ]}
          />
        </Field>
        <Field
          label="Entries JSON"
          hint={
            'Example: [{"teamSeasonId":"uuid","seed":1},{"teamSeasonId":"uuid","seed":2}]'
          }
          required
        >
          <Textarea name="entries" rows={4} required defaultValue="[]" />
        </Field>
        <label className="schedule-check">
          <input name="thirdPlace" type="checkbox" /> Add third-place match
        </label>
        <Button type="submit" disabled={busy || !programId}>
          Create tournament
        </Button>
      </form>
      <div className="schedule-actions">
        <Field label="Bracket ID">
          <Input
            value={bracketId}
            onChange={(event) => {
              setBracketId(event.target.value);
            }}
          />
        </Field>
        <Button
          secondary
          disabled={busy || !bracketId}
          onClick={() => void mutate(() => loadBracket(), 'Bracket loaded.')}
        >
          Load bracket
        </Button>
        {bracket?.bracket.status === 'draft' && (
          <Button
            disabled={busy}
            onClick={() =>
              void mutate(async () => {
                await api(
                  `${base(orgId, 'tournaments')}/brackets/${bracket.bracket.id}/generate`,
                  json({ expectedVersion: bracket.bracket.version }),
                );
                await loadBracket();
              }, 'Bracket generated.')
            }
          >
            Generate bracket
          </Button>
        )}
      </div>
      {bracket && (
        <>
          <div className="schedule-card__title">
            <strong>{bracket.bracket.name}</strong>
            <Badge
              tone={bracket.bracket.status === 'completed' ? 'ok' : 'pending'}
            >
              {bracket.bracket.status}
            </Badge>
          </div>
          <div className="table-scroll">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Seed</th>
                  <th>Status</th>
                  <th>Check-in</th>
                </tr>
              </thead>
              <tbody>
                {bracket.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      {entry.team_season_id ??
                        entry.external_team_id ??
                        entry.id}
                    </td>
                    <td>{entry.seed ?? '—'}</td>
                    <td>{entry.status}</td>
                    <td>
                      {entry.status === 'entered' && (
                        <Button
                          secondary
                          disabled={busy}
                          onClick={() =>
                            void mutate(async () => {
                              await api(
                                `${base(orgId, 'tournaments')}/brackets/${bracket.bracket.id}/entries/${entry.id}/check-in`,
                                json({ expectedVersion: entry.version }),
                              );
                              await loadBracket();
                            }, 'Tournament team checked in.')
                          }
                        >
                          Check in
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-scroll">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Match</th>
                  <th>Bracket slots</th>
                  <th>Contest</th>
                </tr>
              </thead>
              <tbody>
                {bracket.matches.map((match) => (
                  <tr key={match.id}>
                    <td>{match.round}</td>
                    <td>{match.position}</td>
                    <td>
                      <code>
                        {JSON.stringify([
                          match.participant_a,
                          match.participant_b,
                        ])}
                      </code>
                    </td>
                    <td>{match.contest_id ?? 'Not linked'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {bracket.reservations.length > 0 && (
            <>
              <h3>Scheduled tournament slots</h3>
              <div className="table-scroll">
                <table className="ui-table">
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th>Round</th>
                      <th>Game</th>
                      <th>Matchup</th>
                      <th>Start</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bracket.reservations.map((reservation) => (
                      <tr key={reservation.id}>
                        <td>{reservation.slot_type}</td>
                        <td>{reservation.round_index}</td>
                        <td>{reservation.position}</td>
                        <td>{reservation.title}</td>
                        <td>
                          {Temporal.Instant.from(reservation.starts_at)
                            .toZonedDateTimeISO(reservation.timezone)
                            .toLocaleString()}
                        </td>
                        <td>
                          {reservation.published
                            ? 'Published'
                            : `Draft · ${reservation.status}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {bracket.pools.map((pool) => (
            <section key={pool.id} aria-labelledby={`pool-${pool.id}`}>
              <h3 id={`pool-${pool.id}`}>{pool.name} standings</h3>
              <div className="table-scroll">
                <table className="ui-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Team</th>
                      <th>Played</th>
                      <th>W</th>
                      <th>L</th>
                      <th>T</th>
                      <th>Points</th>
                      <th>Differential</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pool.standings.map((row) => (
                      <tr key={row.teamId}>
                        <td>{row.rank}</td>
                        <td>{row.teamId}</td>
                        <td>{row.played}</td>
                        <td>{row.wins}</td>
                        <td>{row.losses}</td>
                        <td>{row.ties}</td>
                        <td>{row.points}</td>
                        <td>{row.differential}</td>
                      </tr>
                    ))}
                    {!pool.standings.length && (
                      <tr>
                        <td colSpan={8}>No teams assigned.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
          <form
            className="schedule-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void mutate(async () => {
                await api(
                  `${base(orgId, 'tournaments')}/brackets/${bracket.bracket.id}/matches/${formText(form, 'matchId')}/contest`,
                  json({
                    contestId: formText(form, 'contestId'),
                    expectedVersion: Number(form.get('matchVersion')),
                  }),
                );
                await loadBracket();
              }, 'Contest linked to bracket match.');
            }}
          >
            <Field label="Match ID" required>
              <Input name="matchId" required />
            </Field>
            <Field label="Match version" required>
              <Input
                name="matchVersion"
                type="number"
                min={1}
                defaultValue={1}
                required
              />
            </Field>
            <Field label="Contest ID" required>
              <Input name="contestId" required />
            </Field>
            <Button type="submit" disabled={busy}>
              Link contest
            </Button>
          </form>
        </>
      )}
      <details className="schedule-details">
        <summary>Create a tournament pool</summary>
        <form
          className="schedule-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const teamSeasonIds = formText(form, 'teamSeasonIds')
              .split(/[\s,]+/)
              .filter(Boolean);
            void mutate(async () => {
              await api(
                `${base(orgId, 'tournaments')}/brackets/${bracketId}/pools`,
                json({
                  name: formText(form, 'poolName'),
                  members: teamSeasonIds.map((teamSeasonId) => ({
                    teamSeasonId,
                  })),
                }),
              );
            }, 'Pool created.');
          }}
        >
          <Field label="Pool name" required>
            <Input name="poolName" required />
          </Field>
          <Field
            label="Team season IDs"
            hint="Paste IDs separated by commas or spaces."
            required
          >
            <Textarea name="teamSeasonIds" rows={3} required />
          </Field>
          <Button type="submit" disabled={busy || !bracketId}>
            Create pool
          </Button>
        </form>
      </details>
      <details className="schedule-details">
        <summary>Seed teams from pool standings</summary>
        <form
          className="schedule-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            let entrants: unknown;
            try {
              entrants = JSON.parse(formText(form, 'entrants'));
            } catch {
              setError('Enter pool entries as valid JSON.');
              return;
            }
            void mutate(async () => {
              setSeedResult(
                await api(
                  `${base(orgId, 'tournaments')}/brackets/pool-seeds`,
                  json({ mode: formText(form, 'mode'), entrants }),
                ),
              );
            }, 'Pool seeding calculated.');
          }}
        >
          <Field label="Seeding mode">
            <Select name="mode" options={['cross_pool', 'overall']} />
          </Field>
          <Field label="Pool standings JSON">
            <Textarea name="entrants" rows={4} defaultValue="[]" required />
          </Field>
          <Button type="submit" disabled={busy}>
            Calculate seeds
          </Button>
        </form>
        {seedResult !== null && (
          <pre className="schedule-json">
            {JSON.stringify(seedResult, null, 2)}
          </pre>
        )}
      </details>
    </section>
  );
}

type PayBatch = {
  batch: { id: string; version: number; status: string };
  totalCents: number;
  lines: unknown[];
};

function OfficialsPanel({
  orgId,
  programId,
}: {
  orgId: string;
  programId: string;
}): React.JSX.Element {
  const [board, setBoard] = useState<unknown>(null);
  const [payBatch, setPayBatch] = useState<PayBatch | null>(null);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function loadBoard(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const query = new URLSearchParams({
        from: new Date(`${formText(form, 'from')}T00:00:00Z`).toISOString(),
        to: new Date(`${formText(form, 'to')}T00:00:00Z`).toISOString(),
        ...(programId ? { programId } : {}),
      });
      setBoard(
        await api(`${base(orgId, 'officials')}/assignment-board?${query}`),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The assignment board could not be loaded.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function perform(
    action: () => Promise<void>,
    success: string,
  ): Promise<void> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The official operation failed.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="schedule-card" aria-labelledby="officials-heading">
      <h2 id="officials-heading">Officials and pay</h2>
      <p>
        Review assignments, offer game positions, and track approved external
        pay batches.
      </p>
      {(error || message) && (
        <p role={error ? 'alert' : 'status'}>{error || message}</p>
      )}
      <form
        className="schedule-form"
        onSubmit={(event) => void loadBoard(event)}
      >
        <Field label="Board from" required>
          <Input name="from" type="date" defaultValue={today()} required />
        </Field>
        <Field label="Board to" required>
          <Input name="to" type="date" defaultValue={today(30)} required />
        </Field>
        <Button type="submit" disabled={busy}>
          Load assignment board
        </Button>
      </form>
      {board !== null && (
        <pre className="schedule-json">{JSON.stringify(board, null, 2)}</pre>
      )}
      <form
        className="schedule-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void perform(async () => {
            await api(
              `${base(orgId, 'officials')}/assignments`,
              json({
                contestId: formText(form, 'contestId'),
                personId: formText(form, 'personId'),
                positionKey: formText(form, 'positionKey'),
              }),
            );
          }, 'Official assignment offered.');
        }}
      >
        <Field label="Contest ID" required>
          <Input name="contestId" required />
        </Field>
        <Field label="Official person ID" required>
          <Input name="personId" required />
        </Field>
        <Field label="Position key" required>
          <Input name="positionKey" required />
        </Field>
        <Button type="submit" disabled={busy}>
          Offer assignment
        </Button>
      </form>
      <form
        className="schedule-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void perform(async () => {
            setPayBatch(
              await api(
                `${base(orgId, 'officials')}/pay-batches`,
                json({
                  periodStart: formText(form, 'periodStart'),
                  periodEnd: formText(form, 'periodEnd'),
                }),
              ),
            );
          }, 'Pay batch drafted.');
        }}
      >
        <Field label="Pay period starts" required>
          <Input name="periodStart" type="date" required />
        </Field>
        <Field label="Pay period ends" required>
          <Input name="periodEnd" type="date" required />
        </Field>
        <Button type="submit" disabled={busy}>
          Draft pay batch
        </Button>
      </form>
      {payBatch && (
        <div className="schedule-run">
          <div className="schedule-card__title">
            <strong>{payBatch.batch.id}</strong>
            <Badge>{payBatch.batch.status}</Badge>
          </div>
          <p>
            Total: ${(payBatch.totalCents / 100).toFixed(2)} ·{' '}
            {payBatch.lines.length} assignments
          </p>
          {payBatch.batch.status === 'draft' && (
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const next = await api<{ version: number; status: string }>(
                    `${base(orgId, 'officials')}/pay-batches/${payBatch.batch.id}/approve`,
                    json({ expectedVersion: payBatch.batch.version }),
                  );
                  setPayBatch({
                    ...payBatch,
                    batch: { ...payBatch.batch, ...next },
                  });
                }, 'Pay batch approved. Payment remains external to this application.')
              }
            >
              Approve batch
            </Button>
          )}
          {payBatch.batch.status === 'approved' && (
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const next = await api<{ version: number; status: string }>(
                    `${base(orgId, 'officials')}/pay-batches/${payBatch.batch.id}/record-payment`,
                    json({
                      expectedVersion: payBatch.batch.version,
                      paidVia: 'external',
                    }),
                  );
                  setPayBatch({
                    ...payBatch,
                    batch: { ...payBatch.batch, ...next },
                  });
                }, 'External payment recorded.')
              }
            >
              Record external payment
            </Button>
          )}
        </div>
      )}
      <div className="schedule-actions">
        <Field label="Calendar year">
          <Input
            type="number"
            min={2000}
            max={2200}
            value={year}
            onChange={(event) => {
              setYear(event.target.value);
            }}
          />
        </Field>
        <Button
          secondary
          onClick={() => {
            window.location.assign(
              `${base(orgId, 'officials')}/payroll/yearly-totals.csv?year=${encodeURIComponent(year)}`,
            );
          }}
        >
          Download yearly totals CSV
        </Button>
      </div>
    </section>
  );
}
