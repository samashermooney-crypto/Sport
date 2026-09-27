import { sportProfileSchema } from '@shared/sport/schema';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { apiPatch } from '../../api/client';
import { Button, Field, Select, Textarea } from '../../ui/primitives';

const response = z.looseObject({
  id: z.uuid(),
  name: z.string(),
  version: z.number().int().positive(),
  profile: sportProfileSchema,
});
const sections = [
  'name',
  'category',
  'participantTerms',
  'contestFormats',
  'positions',
  'maxPositionsPerAthlete',
  'roster',
  'stats',
  'minimumPlayRule',
  'ageGroup',
  'defaultDurations',
  'spaceKinds',
  'officials',
  'evaluationRubric',
  'uniformItems',
  'defaultStandings',
  'skillLevels',
  'disciplineTypes',
] as const;
type Section = (typeof sections)[number];

export function SportProfileEditor({
  orgId,
  profile,
  onSaved,
}: {
  orgId: string;
  profile: {
    id: string;
    name: string;
    version: number;
    profile: unknown;
    hasResults?: boolean | undefined;
  };
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [section, setSection] = useState<Section>('participantTerms');
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const parsed = sportProfileSchema.safeParse(profile.profile);
    if (parsed.success) setDraft(parsed.data);
  }, [profile]);
  useEffect(() => {
    setText(JSON.stringify(draft[section] ?? null, null, 2));
  }, [draft, section]);
  const changeSection = (next: Section) => {
    try {
      setDraft((current) => ({
        ...current,
        [section]: JSON.parse(text) as unknown,
      }));
      setSection(next);
      setError('');
    } catch {
      setError('Fix the JSON in this section before switching');
    }
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const updated = { ...draft, [section]: JSON.parse(text) as unknown };
      const valid = sportProfileSchema.parse(updated);
      await apiPatch(
        `/sports/orgs/${orgId}/${profile.id}`,
        { expectedVersion: profile.version, profile: valid },
        response,
      );
      await onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Profile could not be saved',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {profile.hasResults && (
        <p role="note">
          This sport already has finalized results. Saving creates a new
          version; existing contests keep their recorded profile version.
        </p>
      )}
      {error && (
        <p role="alert" className="phase3-error">
          {error}
        </p>
      )}
      <div className="phase3-form-grid">
        <Field label="Profile section">
          <Select
            value={section}
            onChange={(event) => {
              changeSection(event.target.value as Section);
            }}
          >
            {sections.map((name) => (
              <option key={name} value={name}>
                {name.replace(/([A-Z])/g, ' $1')}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label={`${section.replace(/([A-Z])/g, ' $1')} JSON`}
        hint="Edit the selected section. Saving validates the complete sport profile."
      >
        <Textarea
          rows={14}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
          spellCheck={false}
        />
      </Field>
      <Button
        type="button"
        disabled={busy}
        onClick={() => {
          void save();
        }}
      >
        Save new version
      </Button>
    </div>
  );
}
