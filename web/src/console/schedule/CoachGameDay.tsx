import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge, Button, Field, Select, Textarea } from '../../ui';

import './schedule.css';

type AttendanceRecord = {
  status: 'present' | 'absent' | 'late' | 'excused' | 'unknown';
  version: number;
} | null;
type Athlete = {
  personId: string;
  teamSeasonId: string;
  firstName: string;
  lastName: string;
  positions: string[];
  injured: boolean;
  suspended: boolean;
  allergyFlags: string[];
  emergencyContacts: Array<{
    name: string;
    relationship: string;
    phone: string;
    alternatePhone: string | null;
  }>;
  attendance: AttendanceRecord;
};
type GameDay = {
  event: {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
    arrivalMinutesBefore: number;
  };
  roster: Athlete[];
  contest: {
    id: string;
    status: string;
    version: number;
    format: string;
    score: unknown[];
  } | null;
  lineups: Array<{ team_season_id: string; entries: unknown; version: number }>;
  sportProfile: {
    positions: Array<{ key: string; label: unknown }>;
    minimumPlayRule: { unit: string; defaultRequirement: number } | null;
  } | null;
};
type PendingAction =
  | {
      type: 'attendance';
      eventId: string;
      personId: string;
      status: 'present' | 'absent' | 'late' | 'excused' | 'unknown';
      expectedVersion: number;
    }
  | {
      type: 'result';
      contestId: string;
      expectedVersion: number;
      result: unknown;
      finalize: boolean;
    };

class RequestFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  const value =
    response.status === 204
      ? null
      : ((await response.json().catch(() => null)) as unknown);
  if (!response.ok) {
    const message =
      value && typeof value === 'object' && 'message' in value
        ? String(value.message)
        : `Request failed (${String(response.status)}).`;
    throw new RequestFailure(message, response.status);
  }
  return value as T;
}

const body = (value: unknown): RequestInit => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});

export function CoachGameDay({
  orgId,
  eventId,
}: {
  orgId: string;
  eventId: string;
}): React.JSX.Element {
  const [game, setGame] = useState<GameDay | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [conflict, setConflict] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedTeam, setSelectedTeam] = useState('');
  const [lineupPositions, setLineupPositions] = useState<
    Record<string, string>
  >({});
  const [playTime, setPlayTime] = useState<Record<string, number>>({});
  const syncing = useRef(false);
  const queueKey = `athlentry:gameday:${orgId}:${eventId}`;

  const load = useCallback(async () => {
    try {
      const value = await request<GameDay>(
        `/api/v1/attendance/orgs/${encodeURIComponent(orgId)}/events/${encodeURIComponent(eventId)}/game-day`,
        { cache: 'no-store' },
      );
      setGame(value);
      setSelectedTeam(
        (current) => current || value.roster[0]?.teamSeasonId || '',
      );
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Game-day details could not be loaded.',
      );
    }
  }, [orgId, eventId]);

  useEffect(() => {
    const saved = sessionStorage.getItem(queueKey);
    if (saved) {
      try {
        setPending(JSON.parse(saved) as PendingAction[]);
      } catch {
        sessionStorage.removeItem(queueKey);
      }
    }
    void load();
    const onOnline = () => {
      setOnline(true);
    };
    const onOffline = () => {
      setOnline(false);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [load, queueKey]);

  const saveQueue = useCallback(
    (next: PendingAction[]) => {
      setPending(next);
      if (next.length) sessionStorage.setItem(queueKey, JSON.stringify(next));
      else sessionStorage.removeItem(queueKey);
    },
    [queueKey],
  );

  const applyPendingLocally = useCallback((action: PendingAction) => {
    if (action.type !== 'attendance') return;
    setGame((current) =>
      current
        ? {
            ...current,
            roster: current.roster.map((person) =>
              person.personId === action.personId
                ? {
                    ...person,
                    attendance: {
                      status: action.status,
                      version: action.expectedVersion + 1,
                    },
                  }
                : person,
            ),
          }
        : current,
    );
  }, []);

  const enqueue = useCallback(
    (action: PendingAction) => {
      const next = [...pending, action];
      saveQueue(next);
      applyPendingLocally(action);
      setMessage(
        online
          ? 'Saved locally; syncing when the server responds.'
          : 'Saved on this device. It will sync when you reconnect.',
      );
    },
    [applyPendingLocally, online, pending, saveQueue],
  );

  const send = useCallback(
    async (action: PendingAction): Promise<void> => {
      if (action.type === 'attendance') {
        await request(
          `/api/v1/attendance/orgs/${encodeURIComponent(orgId)}/events/${action.eventId}/people/${action.personId}/attendance`,
          body({
            status: action.status,
            expectedVersion: action.expectedVersion,
          }),
        );
      } else {
        await request(
          `/api/v1/contests/orgs/${encodeURIComponent(orgId)}/contests/${action.contestId}/results`,
          {
            ...body({
              expectedVersion: action.expectedVersion,
              finalize: action.finalize,
              result: action.result,
            }),
            method: 'POST',
          },
        );
      }
    },
    [orgId],
  );

  useEffect(() => {
    if (!online || !pending.length || syncing.current) return;
    syncing.current = true;
    void (async () => {
      let remaining = [...pending];
      for (const action of pending) {
        try {
          await send(action);
          remaining = remaining.filter((item) => item !== action);
          saveQueue(remaining);
          setConflict('');
        } catch (cause) {
          if (cause instanceof RequestFailure && cause.status === 409)
            setConflict(
              'The server changed this record while the device was offline. Reload the game data, then discard or re-enter this change.',
            );
          else if (cause instanceof RequestFailure && cause.status === 422)
            setConflict(
              `The server rejected an offline change: ${cause.message}`,
            );
          else setMessage('A saved change is waiting to sync.');
          break;
        }
      }
      if (!remaining.length) setMessage('All game-day changes are synced.');
      syncing.current = false;
      if (navigator.onLine) void load();
    })().catch(() => {
      syncing.current = false;
    });
  }, [load, online, pending, saveQueue, send]);

  function setAttendance(
    person: Athlete,
    status: NonNullable<Athlete['attendance']>['status'],
  ): void {
    const expectedVersion = person.attendance?.version ?? 0;
    const action: PendingAction = {
      type: 'attendance',
      eventId,
      personId: person.personId,
      status,
      expectedVersion,
    };
    if (!online) {
      enqueue(action);
      return;
    }
    setError('');
    void send(action)
      .then(() => {
        setMessage('Attendance saved.');
        void load();
      })
      .catch((cause: unknown) => {
        if (cause instanceof RequestFailure && cause.status === 409) {
          enqueue(action);
          setConflict(
            'Attendance changed elsewhere; the offline update is queued for your review.',
          );
        } else
          setError(
            cause instanceof Error
              ? cause.message
              : 'Attendance could not be saved.',
          );
      });
  }

  async function submitScore(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!game?.contest) return;
    const form = new FormData(event.currentTarget);
    let result: unknown;
    try {
      const resultJson = form.get('resultJson');
      if (typeof resultJson !== 'string')
        throw new Error('Result entry is missing.');
      result = JSON.parse(resultJson);
    } catch {
      setError('Enter valid JSON for this sport format.');
      return;
    }
    const action: PendingAction = {
      type: 'result',
      contestId: game.contest.id,
      expectedVersion: game.contest.version,
      result,
      finalize: form.get('finalize') === 'on',
    };
    if (!online) {
      enqueue(action);
      return;
    }
    setError('');
    try {
      await send(action);
      setMessage('Score submitted.');
      await load();
    } catch (cause) {
      if (cause instanceof RequestFailure && cause.status === 409) {
        enqueue(action);
        setConflict(
          'The score changed while this device was offline. The server copy was kept; review and re-enter your update.',
        );
      } else
        setError(
          cause instanceof Error ? cause.message : 'Score could not be saved.',
        );
    }
  }

  async function saveLineup(): Promise<void> {
    if (!game?.contest || !selectedTeam) return;
    const existing = game.lineups.find(
      (lineup) => lineup.team_season_id === selectedTeam,
    );
    const entries = game.roster
      .filter(
        (person) =>
          person.teamSeasonId === selectedTeam &&
          lineupPositions[person.personId],
      )
      .map((person, order) => ({
        personId: person.personId,
        position: lineupPositions[person.personId] as string,
        order,
      }));
    setError('');
    try {
      await request(
        `/api/v1/attendance/orgs/${encodeURIComponent(orgId)}/contests/${game.contest.id}/teams/${selectedTeam}/lineup`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: existing?.version ?? 0,
            entries,
          }),
        },
      );
      setMessage('Lineup saved.');
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Lineup could not be saved.',
      );
    }
  }

  const teamIds = [
    ...new Set(game?.roster.map((person) => person.teamSeasonId) ?? []),
  ];
  const teamRoster =
    game?.roster.filter((person) => person.teamSeasonId === selectedTeam) ?? [];
  const rule = game?.sportProfile?.minimumPlayRule;

  return (
    <main className="schedule-page">
      <header className="schedule-page__header">
        <div>
          <p className="schedule-page__eyebrow">Coach view</p>
          <h1>Game day</h1>
          <p>
            {game
              ? `${game.event.title} · ${new Date(game.event.startsAt).toLocaleString()}`
              : 'Loading game details…'}
          </p>
        </div>
        <Badge tone={online ? 'ok' : 'warn'}>
          {online ? 'Online' : 'Offline'}
        </Badge>
      </header>
      {(error || conflict || message) && (
        <div
          className={`schedule-notice${error || conflict ? ' schedule-notice--error' : ''}`}
          role={error || conflict ? 'alert' : 'status'}
        >
          {error || conflict || message}
        </div>
      )}
      {conflict && (
        <div className="schedule-actions">
          <Button
            secondary
            onClick={() => {
              saveQueue([]);
              setConflict('');
              setMessage('Queued offline changes discarded.');
              void load();
            }}
          >
            Discard queued changes and reload
          </Button>
          <span>{pending.length} change(s) still on this device</span>
        </div>
      )}
      {pending.length > 0 && (
        <p role="status">{pending.length} pending offline change(s)</p>
      )}
      {!game && !online && (
        <p>
          Open this game while connected once to load the private roster for
          offline use.
        </p>
      )}
      {game && (
        <>
          <section className="schedule-card" aria-labelledby="gameday-roster">
            <div className="schedule-card__title">
              <div>
                <h2 id="gameday-roster">Roster and attendance</h2>
                <p>
                  Medical and emergency contact details are visible only to
                  authorized game-day staff.
                </p>
              </div>
              <Button secondary onClick={() => void load()}>
                Reload game data
              </Button>
            </div>
            <div className="table-scroll">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th>Athlete</th>
                    <th>Status flags</th>
                    <th>Allergies</th>
                    <th>Emergency contact</th>
                    <th>Attendance</th>
                    <th>Minutes / periods</th>
                  </tr>
                </thead>
                <tbody>
                  {game.roster.map((person) => (
                    <tr key={`${person.teamSeasonId}-${person.personId}`}>
                      <td>
                        {person.firstName} {person.lastName}
                      </td>
                      <td>
                        {person.injured && <Badge tone="warn">Injured</Badge>}{' '}
                        {person.suspended && (
                          <Badge tone="bad">Suspended</Badge>
                        )}
                      </td>
                      <td>
                        {person.allergyFlags.length
                          ? person.allergyFlags.join(', ')
                          : '—'}
                      </td>
                      <td>
                        {person.emergencyContacts.map((contact) => (
                          <span
                            className="schedule-contact"
                            key={`${person.personId}-${contact.phone}`}
                          >
                            <strong>{contact.name}</strong>
                            {contact.relationship &&
                              ` · ${contact.relationship}`}
                            <a href={`tel:${contact.phone}`}>
                              Call {contact.phone}
                            </a>
                            {contact.alternatePhone && (
                              <a href={`tel:${contact.alternatePhone}`}>
                                Call alternate {contact.alternatePhone}
                              </a>
                            )}
                            <a href={`sms:${contact.phone}`}>Text</a>
                          </span>
                        ))}
                      </td>
                      <td>
                        <Select
                          aria-label={`Attendance for ${person.firstName} ${person.lastName}`}
                          value={person.attendance?.status ?? 'unknown'}
                          onChange={(event) => {
                            setAttendance(
                              person,
                              event.target.value as NonNullable<
                                Athlete['attendance']
                              >['status'],
                            );
                          }}
                          options={[
                            'unknown',
                            'present',
                            'absent',
                            'late',
                            'excused',
                          ]}
                        />
                      </td>
                      <td>
                        <label className="schedule-minute">
                          <input
                            aria-label={`${person.firstName} minutes played`}
                            type="number"
                            min={0}
                            max={240}
                            value={playTime[person.personId] ?? 0}
                            onChange={(event) => {
                              setPlayTime({
                                ...playTime,
                                [person.personId]: Number(event.target.value),
                              });
                            }}
                          />
                          {rule?.unit ?? 'minutes'}
                          {rule &&
                            (playTime[person.personId] ?? 0) <
                              rule.defaultRequirement && (
                              <Badge tone="warn">Below minimum</Badge>
                            )}
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="schedule-card" aria-labelledby="gameday-lineup">
            <div className="schedule-card__title">
              <div>
                <h2 id="gameday-lineup">Lineup</h2>
                <p>Suspended athletes are blocked by the server.</p>
              </div>
              <Select
                aria-label="Lineup team"
                value={selectedTeam}
                onChange={(event) => {
                  setSelectedTeam(event.target.value);
                }}
              >
                {teamIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </Select>
            </div>
            {game.sportProfile?.positions.length ? (
              <>
                <div className="table-scroll">
                  <table className="ui-table">
                    <thead>
                      <tr>
                        <th>Athlete</th>
                        <th>Position</th>
                        <th>Order</th>
                      </tr>
                    </thead>
                    <tbody>
                      {teamRoster.map((person) => (
                        <tr key={person.personId}>
                          <td>
                            {person.firstName} {person.lastName}
                            {person.suspended && (
                              <Badge tone="bad">Suspended</Badge>
                            )}
                            {person.injured && (
                              <Badge tone="warn">Injured</Badge>
                            )}
                          </td>
                          <td>
                            <Select
                              aria-label={`Position for ${person.firstName} ${person.lastName}`}
                              value={lineupPositions[person.personId] ?? ''}
                              onChange={(event) => {
                                setLineupPositions({
                                  ...lineupPositions,
                                  [person.personId]: event.target.value,
                                });
                              }}
                            >
                              <option value="">Not in lineup</option>
                              {game.sportProfile?.positions.map((position) => (
                                <option key={position.key} value={position.key}>
                                  {typeof position.label === 'string'
                                    ? position.label
                                    : position.key}
                                </option>
                              ))}
                            </Select>
                          </td>
                          <td>{person.positions.join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button
                  disabled={!game.contest || !online}
                  onClick={() => void saveLineup()}
                >
                  Save lineup
                </Button>
              </>
            ) : (
              <p>Position setup is not configured for this sport profile.</p>
            )}
          </section>
          {game.contest && (
            <section className="schedule-card" aria-labelledby="gameday-score">
              <h2 id="gameday-score">Live score · {game.contest.format}</h2>
              <p>
                Score submissions use the selected sport format and version{' '}
                {game.contest.version}.
              </p>
              <form
                className="schedule-form"
                onSubmit={(event) => void submitScore(event)}
              >
                <Field label="Score or meet result JSON" required>
                  <Textarea
                    name="resultJson"
                    rows={5}
                    defaultValue={'{\n  "home": 0,\n  "away": 0\n}'}
                  />
                </Field>
                <label className="schedule-check">
                  <input name="finalize" type="checkbox" /> Submit as final
                </label>
                <Button type="submit">
                  Save score{online ? '' : ' offline'}
                </Button>
              </form>
            </section>
          )}
        </>
      )}
    </main>
  );
}
