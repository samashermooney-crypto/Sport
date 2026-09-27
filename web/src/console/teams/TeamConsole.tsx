import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Button, Card, Field, Input, Select } from '../../ui/primitives';

import '../programs/programs.css';

const idRow = z.looseObject({ id: z.uuid(), name: z.string() });
const programRow = idRow.extend({ status: z.string() });
const divisionRow = idRow.extend({ is_default: z.boolean() });
const detail = z.object({
  program: programRow,
  divisions: z.array(divisionRow),
  offerings: z.array(z.unknown()),
});
const teamRow = z.looseObject({
  id: z.uuid(),
  name: z.string(),
  team_id: z.uuid(),
  program_id: z.uuid(),
  division_id: z.uuid(),
  status: z.string(),
  version: z.number().int().positive(),
  roster_locked_at: z.string().nullable(),
});
const rosterRow = z.looseObject({
  id: z.uuid(),
  person_id: z.uuid(),
  first_name: z.string(),
  last_name: z.string(),
  jersey_number: z.string().nullable(),
  positions: z.array(z.string()),
  status: z.string(),
  version: z.number().int().positive(),
});
const personList = z.looseObject({
  items: z.array(
    z.looseObject({
      id: z.uuid(),
      firstName: z.string(),
      lastName: z.string(),
    }),
  ),
});

export function TeamConsole({ orgId }: { orgId: string }): React.JSX.Element {
  const [programs, setPrograms] = useState<z.output<typeof programRow>[]>([]);
  const [teams, setTeams] = useState<z.output<typeof teamRow>[]>([]);
  const [divisions, setDivisions] = useState<z.output<typeof divisionRow>[]>(
    [],
  );
  const [people, setPeople] = useState<z.output<typeof personList>['items']>(
    [],
  );
  const [programId, setProgramId] = useState('');
  const [divisionId, setDivisionId] = useState('');
  const [count, setCount] = useState('2');
  const [pattern, setPattern] = useState('Team {n}');
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [roster, setRoster] = useState<z.output<typeof rosterRow>[]>([]);
  const [personId, setPersonId] = useState('');
  const [jersey, setJersey] = useState('');
  const [role, setRole] = useState('head_coach');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [nextPrograms, nextTeams, nextPeople] = await Promise.all([
      apiGet(`/programs/orgs/${orgId}`, z.array(programRow)),
      apiGet(`/teams/orgs/${orgId}`, z.array(teamRow)),
      apiGet(`/people/orgs/${orgId}?limit=100`, personList),
    ]);
    setPrograms(nextPrograms);
    setTeams(nextTeams);
    setPeople(nextPeople.items);
    setProgramId((current) => current || nextPrograms[0]?.id || '');
  }, [orgId]);
  useEffect(() => {
    void load().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Teams unavailable');
    });
  }, [load]);
  useEffect(() => {
    if (!programId) return;
    void apiGet(`/programs/orgs/${orgId}/${programId}`, detail)
      .then((data) => {
        setDivisions(data.divisions);
        setDivisionId((current) =>
          data.divisions.some((item) => item.id === current)
            ? current
            : data.divisions[0]?.id || '',
        );
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : 'Divisions unavailable',
        );
      });
  }, [orgId, programId]);
  useEffect(() => {
    if (!selectedTeamId) return;
    void apiGet(
      `/rosters/orgs/${orgId}/team-seasons/${selectedTeamId}`,
      z.array(rosterRow),
    )
      .then(setRoster)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Roster unavailable');
      });
  }, [orgId, selectedTeamId]);
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await load();
      if (selectedTeamId)
        setRoster(
          await apiGet(
            `/rosters/orgs/${orgId}/team-seasons/${selectedTeamId}`,
            z.array(rosterRow),
          ),
        );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not save changes',
      );
    } finally {
      setBusy(false);
    }
  };
  const selectedTeam = teams.find((team) => team.id === selectedTeamId);
  return (
    <div className="phase3-stack">
      {error && (
        <p role="alert" className="phase3-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="phase3-notice">
          {notice}
        </p>
      )}
      <Card>
        <h2>Generate teams</h2>
        <p>Create persistent team identities in a program division.</p>
        <form
          className="phase3-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              const rows = await apiPost(
                `/teams/orgs/${orgId}/generate`,
                { programId, divisionId, count: Number(count), pattern },
                z.array(
                  z.object({
                    team: idRow,
                    season: z.looseObject({ id: z.uuid() }),
                  }),
                ),
              );
              setNotice(`Created ${String(rows.length)} teams`);
            });
          }}
        >
          <Field label="Program">
            <Select
              value={programId}
              onChange={(event) => {
                setProgramId(event.target.value);
              }}
            >
              <option value="">Choose program</option>
              {programs.map((program) => (
                <option key={program.id} value={program.id}>
                  {program.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Division">
            <Select
              value={divisionId}
              onChange={(event) => {
                setDivisionId(event.target.value);
              }}
            >
              <option value="">Choose division</option>
              {divisions.map((division) => (
                <option key={division.id} value={division.id}>
                  {division.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Number of teams">
            <Input
              type="number"
              min="1"
              max="100"
              value={count}
              onChange={(event) => {
                setCount(event.target.value);
              }}
            />
          </Field>
          <Field label="Naming pattern" hint="Use {n} for the number">
            <Input
              value={pattern}
              onChange={(event) => {
                setPattern(event.target.value);
              }}
            />
          </Field>
          <Button disabled={busy || !programId || !divisionId}>
            Generate teams
          </Button>
        </form>
      </Card>
      <Card>
        <h2>Team seasons</h2>
        <Field label="Team">
          <Select
            value={selectedTeamId}
            onChange={(event) => {
              setSelectedTeamId(event.target.value);
            }}
          >
            <option value="">Choose team</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name} · {team.status}
              </option>
            ))}
          </Select>
        </Field>
        {selectedTeam && (
          <div>
            <p>
              {selectedTeam.name} · {selectedTeam.status}
            </p>
            <Button
              type="button"
              secondary
              disabled={busy}
              onClick={() => {
                void mutate(async () => {
                  await apiPost(
                    `/teams/orgs/${orgId}/seasons/${selectedTeam.id}/roster-lock`,
                    {
                      expectedVersion: selectedTeam.version,
                      locked: !selectedTeam.roster_locked_at,
                    },
                    teamRow,
                  );
                  setNotice(
                    selectedTeam.roster_locked_at
                      ? 'Roster unlocked'
                      : 'Roster locked',
                  );
                });
              }}
            >
              {selectedTeam.roster_locked_at ? 'Unlock roster' : 'Lock roster'}
            </Button>
          </div>
        )}
      </Card>
      {selectedTeam && (
        <Card>
          <h2>Roster</h2>
          <p>
            <a
              href={`/api/v1/rosters/orgs/${orgId}/team-seasons/${selectedTeam.id}/export.csv`}
            >
              Download CSV
            </a>{' '}
            ·{' '}
            <button
              type="button"
              onClick={() => {
                window.print();
              }}
            >
              Print roster
            </button>
          </p>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Jersey</th>
                <th>Positions</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    {entry.first_name} {entry.last_name}
                  </td>
                  <td>{entry.jersey_number ?? '—'}</td>
                  <td>{entry.positions.join(', ') || '—'}</td>
                  <td>{entry.status}</td>
                  <td>
                    <Button
                      type="button"
                      secondary
                      disabled={busy || Boolean(selectedTeam.roster_locked_at)}
                      onClick={() => {
                        void mutate(async () => {
                          await apiPost(
                            `/rosters/orgs/${orgId}/${entry.id}/release`,
                            { expectedVersion: entry.version },
                            z.looseObject({ id: z.uuid() }),
                          );
                          setNotice('Athlete released from roster');
                        });
                      }}
                    >
                      Release
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form
            className="phase3-form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(async () => {
                await apiPost(
                  `/rosters/orgs/${orgId}/team-seasons/${selectedTeam.id}`,
                  { personId, jerseyNumber: jersey || null },
                  z.looseObject({ id: z.uuid() }),
                );
                setNotice('Athlete added to roster');
              });
            }}
          >
            <Field label="Athlete">
              <Select
                value={personId}
                onChange={(event) => {
                  setPersonId(event.target.value);
                }}
              >
                <option value="">Choose person</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.firstName} {person.lastName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Jersey">
              <Input
                value={jersey}
                onChange={(event) => {
                  setJersey(event.target.value);
                }}
              />
            </Field>
            <Button
              disabled={
                busy || !personId || Boolean(selectedTeam.roster_locked_at)
              }
            >
              Add to roster
            </Button>
          </form>
          <h3>Team staff</h3>
          <form
            className="phase3-form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(async () => {
                await apiPost(
                  `/teams/orgs/${orgId}/seasons/${selectedTeam.id}/staff`,
                  { personId, role },
                  z.looseObject({ id: z.uuid(), status: z.string() }),
                );
                setNotice('Staff assignment saved with compliance status');
              });
            }}
          >
            <Field label="Person">
              <Select
                value={personId}
                onChange={(event) => {
                  setPersonId(event.target.value);
                }}
              >
                <option value="">Choose person</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.firstName} {person.lastName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Role">
              <Select
                value={role}
                onChange={(event) => {
                  setRole(event.target.value);
                }}
                options={[
                  'head_coach',
                  'assistant_coach',
                  'team_manager',
                  'trainer',
                  'treasurer',
                  'other',
                ]}
              />
            </Field>
            <Button disabled={busy || !personId}>Assign staff</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
