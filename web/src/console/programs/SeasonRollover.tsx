import { useState } from 'react';
import { z } from 'zod';

import { apiPost } from '../../api/client';
import { Button, Field, Input, Select } from '../../ui/primitives';

const previewSchema = z.looseObject({
  source: z.object({
    id: z.uuid(),
    name: z.string(),
    startsOn: z.string(),
    endsOn: z.string(),
  }),
  target: z.object({
    name: z.string(),
    startsOn: z.string(),
    endsOn: z.string(),
  }),
  programs: z.array(
    z.looseObject({
      id: z.uuid(),
      name: z.string(),
      startsOn: z.string(),
      endsOn: z.string(),
      copiedStartsOn: z.string(),
      copiedEndsOn: z.string(),
    }),
  ),
  teams: z.array(
    z.looseObject({ id: z.uuid(), name: z.string(), returning: z.boolean() }),
  ),
  staff: z.array(
    z.looseObject({
      id: z.uuid(),
      team_season_id: z.uuid(),
      role: z.string(),
      first_name: z.string(),
      last_name: z.string(),
      carryOver: z.boolean(),
    }),
  ),
  exclusions: z.array(z.string()),
});
const copySchema = z.object({
  season: z.looseObject({ id: z.uuid(), name: z.string() }),
  copied: z.object({
    programs: z.number(),
    teams: z.number(),
    staff: z.number(),
  }),
});

export function SeasonRollover({
  orgId,
  seasons,
  onCopied,
}: {
  orgId: string;
  seasons: { id: string; name: string }[];
  onCopied: () => Promise<void>;
}): React.JSX.Element {
  const [sourceId, setSourceId] = useState('');
  const [name, setName] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [offsetDays, setOffsetDays] = useState('365');
  const [preview, setPreview] = useState<z.output<typeof previewSchema> | null>(
    null,
  );
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [teams, setTeams] = useState<string[]>([]);
  const [staff, setStaff] = useState<string[]>([]);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dateMap = () =>
    Object.fromEntries(
      (preview?.programs ?? []).flatMap((program) => {
        const entries: [string, string][] = [];
        const start = overrides[program.startsOn];
        const end = overrides[program.endsOn];
        if (start && start !== program.copiedStartsOn)
          entries.push([program.startsOn, start]);
        if (end && end !== program.copiedEndsOn)
          entries.push([program.endsOn, end]);
        return entries;
      }),
    );
  const payload = (selectedTeams = teams, selectedStaff = staff) => ({
    name,
    startsOn,
    endsOn,
    offsetDays: Number(offsetDays),
    dateMap: dateMap(),
    returningTeamSeasonIds: selectedTeams,
    carryStaffIds: selectedStaff,
  });
  const loadPreview = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiPost(
        `/seasons/orgs/${orgId}/${sourceId}/rollover/preview`,
        payload([], []),
        previewSchema,
      );
      setPreview(result);
      setTeams(result.teams.map((team) => team.id));
      setStaff(result.staff.map((member) => member.id));
      setOverrides(
        Object.fromEntries(
          result.programs.flatMap((program) => [
            [program.startsOn, program.copiedStartsOn],
            [program.endsOn, program.copiedEndsOn],
          ]),
        ),
      );
      setKey(crypto.randomUUID());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not preview season',
      );
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    setBusy(true);
    setError('');
    try {
      const selectedStaff = staff.filter((id) =>
        preview?.staff.some(
          (member) => member.id === id && teams.includes(member.team_season_id),
        ),
      );
      const result = await apiPost(
        `/seasons/orgs/${orgId}/${sourceId}/rollover`,
        payload(teams, selectedStaff),
        copySchema,
        key,
      );
      setNotice(
        `Copied ${String(result.copied.programs)} programs, ${String(result.copied.teams)} teams and ${String(result.copied.staff)} staff into ${result.season.name}`,
      );
      setPreview(null);
      await onCopied();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not copy season',
      );
    } finally {
      setBusy(false);
    }
  };
  const toggle = (
    id: string,
    selected: string[],
    setSelected: (ids: string[]) => void,
  ) => {
    setSelected(
      selected.includes(id)
        ? selected.filter((item) => item !== id)
        : [...selected, id],
    );
  };
  return (
    <div>
      <h3>Copy season</h3>
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
      <form
        className="phase3-form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void loadPreview();
        }}
      >
        <Field label="Source season">
          <Select
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
            }}
            required
          >
            <option value="">Choose season</option>
            {seasons.map((season) => (
              <option key={season.id} value={season.id}>
                {season.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="New season name">
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            required
          />
        </Field>
        <Field label="Starts">
          <Input
            type="date"
            value={startsOn}
            onChange={(event) => {
              setStartsOn(event.target.value);
            }}
            required
          />
        </Field>
        <Field label="Ends">
          <Input
            type="date"
            value={endsOn}
            onChange={(event) => {
              setEndsOn(event.target.value);
            }}
            required
          />
        </Field>
        <Field label="Shift dates by days">
          <Input
            type="number"
            min="-3660"
            max="3660"
            value={offsetDays}
            onChange={(event) => {
              setOffsetDays(event.target.value);
            }}
            required
          />
        </Field>
        <Button disabled={busy || !sourceId}>Preview copy</Button>
      </form>
      {preview && (
        <div>
          <h4>Preview changes</h4>
          <p>
            {preview.source.name} → {preview.target.name}
          </p>
          {preview.programs.map((program) => (
            <div className="phase3-check" key={program.id}>
              <strong>{program.name}</strong>
              <Field label="Program starts">
                <Input
                  type="date"
                  value={overrides[program.startsOn] ?? program.copiedStartsOn}
                  onChange={(event) => {
                    setOverrides({
                      ...overrides,
                      [program.startsOn]: event.target.value,
                    });
                  }}
                />
              </Field>
              <Field label="Program ends">
                <Input
                  type="date"
                  value={overrides[program.endsOn] ?? program.copiedEndsOn}
                  onChange={(event) => {
                    setOverrides({
                      ...overrides,
                      [program.endsOn]: event.target.value,
                    });
                  }}
                />
              </Field>
            </div>
          ))}
          <Button
            type="button"
            disabled={busy || !sourceId}
            onClick={() => {
              void loadPreview();
            }}
          >
            Update preview
          </Button>
          <h4>Returning teams</h4>
          {preview.teams.map((team) => (
            <label className="phase3-check" key={team.id}>
              <input
                type="checkbox"
                checked={teams.includes(team.id)}
                onChange={() => {
                  toggle(team.id, teams, setTeams);
                }}
              />{' '}
              {team.name}
            </label>
          ))}
          <h4>Carry staff for revalidation</h4>
          {preview.staff.map((member) => (
            <label className="phase3-check" key={member.id}>
              <input
                type="checkbox"
                checked={staff.includes(member.id)}
                onChange={() => {
                  toggle(member.id, staff, setStaff);
                }}
              />{' '}
              {member.first_name} {member.last_name} — {member.role}
            </label>
          ))}
          <p>Never copied: {preview.exclusions.join(', ')}.</p>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              void copy();
            }}
          >
            Copy season
          </Button>
        </div>
      )}
    </div>
  );
}
