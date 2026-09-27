import { sportProfileSchema } from '@shared/sport/schema';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import { Button, Card, Field, Input, Select } from '../../ui/primitives';

import '../programs/programs.css';

const idRow = z.looseObject({ id: z.uuid(), name: z.string() });
const programRow = idRow.extend({
  status: z.string(),
  sport_profile_id: z.uuid(),
});
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
  display_name: z.string().nullable(),
  roster_limit: z.number().nullable(),
  home_facility_id: z.uuid().nullable(),
  sport_profile_id: z.uuid(),
  status: z.string(),
  version: z.number().int().positive(),
  team_version: z.number().int().positive(),
  roster_locked_at: z.string().nullable(),
});
const teamSeasonMutationRow = z.looseObject({
  id: z.uuid(),
  version: z.number().int().positive(),
  roster_locked_at: z.string().nullable(),
});
const rosterRow = z.looseObject({
  id: z.uuid(),
  person_id: z.uuid(),
  kind: z.enum(['rostered', 'guest', 'practice_only']),
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
const staffRow = z.looseObject({
  id: z.uuid(),
  person_id: z.uuid(),
  role: z.string(),
  status: z.string(),
  version: z.number().int().positive(),
  first_name: z.string(),
  last_name: z.string(),
});
const profileRow = z.object({ id: z.uuid(), profile: sportProfileSchema });

export function TeamConsole({ orgId }: { orgId: string }): React.JSX.Element {
  const [programs, setPrograms] = useState<z.output<typeof programRow>[]>([]);
  const [teams, setTeams] = useState<z.output<typeof teamRow>[]>([]);
  const [profiles, setProfiles] = useState<z.output<typeof profileRow>[]>([]);
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
  const [staff, setStaff] = useState<z.output<typeof staffRow>[]>([]);
  const [personId, setPersonId] = useState('');
  const [staffPersonId, setStaffPersonId] = useState('');
  const [jersey, setJersey] = useState('');
  const [kind, setKind] = useState<'rostered' | 'guest' | 'practice_only'>(
    'rostered',
  );
  const [positions, setPositions] = useState<string[]>([]);
  const [editingRosterEntryId, setEditingRosterEntryId] = useState('');
  const [editingJersey, setEditingJersey] = useState('');
  const [editingPositions, setEditingPositions] = useState<string[]>([]);
  const [destinationTeamSeasonId, setDestinationTeamSeasonId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [manualTeamName, setManualTeamName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [rosterLimit, setRosterLimit] = useState('');
  const [teamSeasonStatus, setTeamSeasonStatus] = useState('forming');
  const [role, setRole] = useState('head_coach');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [nextPrograms, nextTeams, nextPeople, nextProfiles] =
      await Promise.all([
        apiGet(`/programs/orgs/${orgId}`, z.array(programRow)),
        apiGet(`/teams/orgs/${orgId}`, z.array(teamRow)),
        apiGet(`/people/orgs/${orgId}?limit=100`, personList),
        apiGet(`/sports/orgs/${orgId}`, z.array(profileRow)),
      ]);
    setPrograms(nextPrograms);
    setTeams(nextTeams);
    setPeople(nextPeople.items);
    setProfiles(nextProfiles);
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
    const selected = teams.find((team) => team.id === selectedTeamId);
    if (selected) {
      setTeamName(selected.name);
      setDisplayName(selected.display_name ?? '');
      setRosterLimit(
        selected.roster_limit === null ? '' : String(selected.roster_limit),
      );
      setTeamSeasonStatus(selected.status);
    }
  }, [selectedTeamId, teams]);
  useEffect(() => {
    if (!selectedTeamId) return;
    let current = true;
    void Promise.all([
      apiGet(
        `/rosters/orgs/${orgId}/team-seasons/${selectedTeamId}`,
        z.array(rosterRow),
      ),
      apiGet(
        `/teams/orgs/${orgId}/seasons/${selectedTeamId}/staff`,
        z.array(staffRow),
      ),
    ])
      .then(([nextRoster, nextStaff]) => {
        if (!current) return;
        setRoster(nextRoster);
        setStaff(nextStaff);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setError(
          cause instanceof Error ? cause.message : 'Team data unavailable',
        );
      });
    return () => {
      current = false;
    };
  }, [orgId, selectedTeamId]);
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await load();
      if (selectedTeamId) {
        const [nextRoster, nextStaff] = await Promise.all([
          apiGet(
            `/rosters/orgs/${orgId}/team-seasons/${selectedTeamId}`,
            z.array(rosterRow),
          ),
          apiGet(
            `/teams/orgs/${orgId}/seasons/${selectedTeamId}/staff`,
            z.array(staffRow),
          ),
        ]);
        setRoster(nextRoster);
        setStaff(nextStaff);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not save changes',
      );
    } finally {
      setBusy(false);
    }
  };
  const selectedTeam = teams.find((team) => team.id === selectedTeamId);
  const selectedProfile = profiles.find(
    (profile) => profile.id === selectedTeam?.sport_profile_id,
  )?.profile;
  const positionOptions = selectedProfile?.positions ?? [];
  const rosterLocked = Boolean(selectedTeam?.roster_locked_at);
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
        <h2>Create a team manually</h2>
        <form
          className="phase3-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            const selectedProgram = programs.find(
              (program) => program.id === programId,
            );
            if (!selectedProgram || !divisionId) {
              setError('Choose a program and division first');
              return;
            }
            void mutate(async () => {
              const created = await apiPost(
                `/teams/orgs/${orgId}/seasons/manual`,
                {
                  team: {
                    name: manualTeamName,
                    sportProfileId: selectedProgram.sport_profile_id,
                  },
                  programId,
                  divisionId,
                },
                z.object({
                  team: z.looseObject({ id: z.uuid() }),
                  season: z.looseObject({ id: z.uuid() }),
                }),
              );
              setManualTeamName('');
              setSelectedTeamId(created.season.id);
              setNotice(`Created ${manualTeamName.trim()}`);
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
          <Field label="Persistent team name">
            <Input
              value={manualTeamName}
              onChange={(event) => {
                setManualTeamName(event.target.value);
              }}
              required
            />
          </Field>
          <Button disabled={busy || !programId || !divisionId}>
            Create team
          </Button>
        </form>
      </Card>
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
            <form
              className="phase3-form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(async () => {
                  await apiPatch(
                    `/teams/orgs/${orgId}/${selectedTeam.team_id}`,
                    {
                      expectedVersion: selectedTeam.team_version,
                      name: teamName,
                    },
                    z.looseObject({
                      id: z.uuid(),
                      version: z.number().int().positive(),
                    }),
                  );
                  setNotice('Persistent team name saved');
                });
              }}
            >
              <Field label="Persistent team name">
                <Input
                  value={teamName}
                  onChange={(event) => {
                    setTeamName(event.target.value);
                  }}
                  required
                />
              </Field>
              <Button disabled={busy}>Save team name</Button>
            </form>
            <form
              className="phase3-form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(async () => {
                  await apiPatch(
                    `/teams/orgs/${orgId}/seasons/${selectedTeam.id}`,
                    {
                      expectedVersion: selectedTeam.version,
                      displayName: displayName || null,
                      rosterLimit: rosterLimit ? Number(rosterLimit) : null,
                      status: teamSeasonStatus,
                    },
                    teamSeasonMutationRow,
                  );
                  setNotice('Team-season settings saved');
                });
              }}
            >
              <Field label="Season display name">
                <Input
                  value={displayName}
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                  }}
                />
              </Field>
              <Field label="Roster limit">
                <Input
                  type="number"
                  min="1"
                  value={rosterLimit}
                  onChange={(event) => {
                    setRosterLimit(event.target.value);
                  }}
                />
              </Field>
              <Field label="Team-season status">
                <Select
                  value={teamSeasonStatus}
                  onChange={(event) => {
                    setTeamSeasonStatus(event.target.value);
                  }}
                  options={[
                    teamSeasonStatus,
                    ...(teamSeasonStatus === 'forming'
                      ? ['active', 'withdrawn']
                      : teamSeasonStatus === 'active'
                        ? ['completed', 'withdrawn']
                        : []),
                  ]}
                />
              </Field>
              <Button disabled={busy}>Save team settings</Button>
            </form>
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
                    teamSeasonMutationRow,
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
            <Field label="Move players to">
              <Select
                value={destinationTeamSeasonId}
                onChange={(event) => {
                  setDestinationTeamSeasonId(event.target.value);
                }}
              >
                <option value="">Choose destination team</option>
                {teams
                  .filter(
                    (team) =>
                      team.program_id === selectedTeam.program_id &&
                      team.id !== selectedTeam.id,
                  )
                  .map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
              </Select>
            </Field>
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
                <th>Kind</th>
                <th>Jersey</th>
                <th>Positions</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    {entry.first_name} {entry.last_name}
                  </td>
                  <td>{entry.kind.replaceAll('_', ' ')}</td>
                  <td>{entry.jersey_number ?? '—'}</td>
                  <td>{entry.positions.join(', ') || '—'}</td>
                  <td>{entry.status}</td>
                  <td>
                    <Button
                      type="button"
                      secondary
                      disabled={busy || rosterLocked}
                      onClick={() => {
                        setEditingRosterEntryId(entry.id);
                        setEditingJersey(entry.jersey_number ?? '');
                        setEditingPositions(entry.positions);
                      }}
                    >
                      Edit
                    </Button>{' '}
                    <Button
                      type="button"
                      secondary
                      disabled={
                        busy || rosterLocked || !destinationTeamSeasonId
                      }
                      onClick={() => {
                        void mutate(async () => {
                          await apiPost(
                            `/rosters/orgs/${orgId}/${entry.id}/move`,
                            {
                              destinationTeamSeasonId,
                              expectedVersion: entry.version,
                            },
                            rosterRow,
                          );
                          setNotice('Athlete moved to another team');
                        });
                      }}
                    >
                      Move
                    </Button>{' '}
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
          {editingRosterEntryId && (
            <form
              className="phase3-form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                const entry = roster.find(
                  (candidate) => candidate.id === editingRosterEntryId,
                );
                if (!entry) return;
                void mutate(async () => {
                  await apiPatch(
                    `/rosters/orgs/${orgId}/${entry.id}`,
                    {
                      expectedVersion: entry.version,
                      jerseyNumber: editingJersey || null,
                      positions: editingPositions,
                    },
                    rosterRow,
                  );
                  setEditingRosterEntryId('');
                  setNotice('Roster entry updated');
                });
              }}
            >
              <h3>Edit roster entry</h3>
              <Field label="Jersey">
                <Input
                  type="number"
                  min={selectedProfile?.roster.jerseyRange?.[0]}
                  max={selectedProfile?.roster.jerseyRange?.[1]}
                  disabled={selectedProfile?.roster.jerseyNumbers === 'none'}
                  value={editingJersey}
                  onChange={(event) => {
                    setEditingJersey(event.target.value);
                  }}
                />
              </Field>
              {positionOptions.length > 0 && (
                <fieldset>
                  <legend>Positions</legend>
                  {positionOptions.map((position) => (
                    <label key={position.key}>
                      <input
                        type="checkbox"
                        checked={editingPositions.includes(position.key)}
                        disabled={
                          !editingPositions.includes(position.key) &&
                          editingPositions.length >=
                            (selectedProfile?.maxPositionsPerAthlete ?? 0)
                        }
                        onChange={(change) => {
                          setEditingPositions((current) =>
                            change.target.checked
                              ? [...current, position.key]
                              : current.filter((key) => key !== position.key),
                          );
                        }}
                      />{' '}
                      {position.label.en}
                    </label>
                  ))}
                </fieldset>
              )}
              <Button disabled={busy || rosterLocked}>Save roster entry</Button>{' '}
              <Button
                type="button"
                secondary
                onClick={() => {
                  setEditingRosterEntryId('');
                }}
              >
                Cancel
              </Button>
            </form>
          )}
          <form
            className="phase3-form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(async () => {
                await apiPost(
                  `/rosters/orgs/${orgId}/team-seasons/${selectedTeam.id}`,
                  {
                    personId,
                    jerseyNumber: jersey || null,
                    kind,
                    positions,
                  },
                  z.looseObject({ id: z.uuid() }),
                );
                setJersey('');
                setPositions([]);
                setKind('rostered');
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
                type={
                  selectedProfile?.roster.jerseyNumbers === 'none'
                    ? 'text'
                    : 'number'
                }
                min={selectedProfile?.roster.jerseyRange?.[0]}
                max={selectedProfile?.roster.jerseyRange?.[1]}
                disabled={selectedProfile?.roster.jerseyNumbers === 'none'}
                required={selectedProfile?.roster.jerseyNumbers === 'required'}
                value={jersey}
                onChange={(event) => {
                  setJersey(event.target.value);
                }}
              />
            </Field>
            <Field label="Roster role">
              <Select
                value={kind}
                onChange={(event) => {
                  setKind(
                    event.target.value as
                      'rostered' | 'guest' | 'practice_only',
                  );
                }}
                options={[
                  { value: 'rostered', label: 'Rostered player' },
                  { value: 'guest', label: 'Guest player' },
                  { value: 'practice_only', label: 'Practice only' },
                ]}
              />
            </Field>
            {positionOptions.length > 0 && (
              <fieldset>
                <legend>Positions</legend>
                <p>
                  Choose up to {selectedProfile?.maxPositionsPerAthlete}{' '}
                  positions.
                </p>
                {positionOptions.map((position) => (
                  <label key={position.key}>
                    <input
                      type="checkbox"
                      checked={positions.includes(position.key)}
                      disabled={
                        !positions.includes(position.key) &&
                        positions.length >=
                          (selectedProfile?.maxPositionsPerAthlete ?? 0)
                      }
                      onChange={(event) => {
                        setPositions((current) =>
                          event.target.checked
                            ? [...current, position.key]
                            : current.filter((key) => key !== position.key),
                        );
                      }}
                    />{' '}
                    {position.label.en}
                  </label>
                ))}
              </fieldset>
            )}
            <Field label="Roster role">
              <Select
                value={kind}
                onChange={(event) => {
                  setKind(
                    event.target.value as
                      'rostered' | 'guest' | 'practice_only',
                  );
                }}
                options={[
                  { value: 'rostered', label: 'Rostered player' },
                  { value: 'guest', label: 'Guest player' },
                  { value: 'practice_only', label: 'Practice only' },
                ]}
              />
            </Field>
            {positionOptions.length > 0 && (
              <fieldset>
                <legend>Positions</legend>
                <p>
                  Choose up to {selectedProfile?.maxPositionsPerAthlete}{' '}
                  positions.
                </p>
                {positionOptions.map((position) => (
                  <label key={position.key}>
                    <input
                      type="checkbox"
                      checked={positions.includes(position.key)}
                      disabled={
                        !positions.includes(position.key) &&
                        positions.length >=
                          (selectedProfile?.maxPositionsPerAthlete ?? 0)
                      }
                      onChange={(event) => {
                        setPositions((current) =>
                          event.target.checked
                            ? [...current, position.key]
                            : current.filter((key) => key !== position.key),
                        );
                      }}
                    />{' '}
                    {position.label.en}
                  </label>
                ))}
              </fieldset>
            )}
            <Button
              disabled={
                busy || !personId || Boolean(selectedTeam.roster_locked_at)
              }
            >
              Add to roster
            </Button>
          </form>
          <h3>Team staff</h3>
          {staff.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((member) => (
                  <tr key={member.id}>
                    <td>
                      {member.first_name} {member.last_name}
                    </td>
                    <td>{member.role.replaceAll('_', ' ')}</td>
                    <td>{member.status.replaceAll('_', ' ')}</td>
                    <td>
                      {member.status === 'pending_compliance' && (
                        <Button
                          type="button"
                          secondary
                          disabled={busy}
                          onClick={() => {
                            void mutate(async () => {
                              const updated = await apiPost(
                                `/teams/orgs/${orgId}/staff/${member.id}/revalidate`,
                                {},
                                staffRow,
                              );
                              setNotice(
                                `Compliance rechecked: ${updated.status.replaceAll('_', ' ')}`,
                              );
                            });
                          }}
                        >
                          Recheck
                        </Button>
                      )}{' '}
                      <Button
                        type="button"
                        secondary
                        disabled={busy}
                        onClick={() => {
                          void mutate(async () => {
                            await apiPost(
                              `/teams/orgs/${orgId}/staff/${member.id}/remove`,
                              { expectedVersion: member.version },
                              z.looseObject({ id: z.uuid() }),
                            );
                            setNotice('Staff member removed');
                          });
                        }}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form
            className="phase3-form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(async () => {
                await apiPost(
                  `/teams/orgs/${orgId}/seasons/${selectedTeam.id}/staff`,
                  { personId: staffPersonId, role },
                  z.looseObject({ id: z.uuid(), status: z.string() }),
                );
                setNotice('Staff assignment saved with compliance status');
              });
            }}
          >
            <Field label="Person">
              <Select
                value={staffPersonId}
                onChange={(event) => {
                  setStaffPersonId(event.target.value);
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
            <Button disabled={busy || !staffPersonId}>Assign staff</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
