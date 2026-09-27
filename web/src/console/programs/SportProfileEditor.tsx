import { sportProfileSchema } from '@shared/sport/schema';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { apiPatch } from '../../api/client';
import { Button, Field, Input, Select } from '../../ui/primitives';

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

type SchemaDef = {
  type: string;
  innerType?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  items?: z.ZodType[];
  options?: z.ZodType[];
  entries?: Record<string, string | number>;
  values?: readonly (string | number | boolean | null)[];
  defaultValue?: unknown;
  discriminator?: string;
};
const defOf = (schema: z.ZodType): SchemaDef =>
  schema.def as unknown as SchemaDef;

const seed = (schema: z.ZodType): unknown => {
  const def = defOf(schema);
  switch (def.type) {
    case 'default':
    case 'prefault':
      return def.defaultValue;
    case 'optional':
    case 'nullable':
    case 'nonoptional':
    case 'readonly':
      return def.innerType ? seed(def.innerType) : undefined;
    case 'literal':
      return def.values?.[0];
    case 'enum':
      return def.entries ? Object.values(def.entries)[0] : undefined;
    case 'string':
      return '';
    case 'number':
    case 'int':
      return 1;
    case 'boolean':
      return false;
    case 'object':
      return Object.fromEntries(
        Object.entries(def.shape ?? {})
          .filter(([, child]) => {
            const childDef = defOf(child);
            return !(
              childDef.type === 'optional' ||
              childDef.type === 'default' ||
              childDef.type === 'nullable'
            );
          })
          .map(([key, child]) => [key, seed(child)]),
      );
    case 'array':
      return [];
    case 'tuple':
      return (def.items ?? []).map((item) => seed(item));
    case 'union': {
      const options = def.options ?? [];
      if (def.discriminator) {
        const option = options[0] ?? z.unknown();
        const disc = def.discriminator;
        return { ...(seed(option) as object), [disc]: undefined };
      }
      return seed(options[0] ?? z.unknown());
    }
    default:
      return undefined;
  }
};

const label = (key: string): string =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (first) => first.toUpperCase());

function Editor({
  schema,
  value,
  onChange,
}: {
  schema: z.ZodType;
  value: unknown;
  onChange: (next: unknown) => void;
}): React.JSX.Element {
  const def = defOf(schema);
  switch (def.type) {
    case 'default':
    case 'prefault': {
      const inner = def.innerType;
      if (!inner) return <span />;
      return (
        <Editor
          schema={inner}
          value={value === undefined ? def.defaultValue : value}
          onChange={onChange}
        />
      );
    }
    case 'optional':
    case 'nullable': {
      const inner = def.innerType;
      if (!inner) return <span />;
      const set = def.type === 'optional' ? value !== undefined : value !== null;
      const empty = def.type === 'optional' ? undefined : null;
      return (
        <div>
          <label>
            <input
              type="checkbox"
              checked={set}
              onChange={(event) => {
                onChange(event.target.checked ? seed(inner) : empty);
              }}
            />{' '}
            Set
          </label>
          {set && <Editor schema={inner} value={value} onChange={onChange} />}
        </div>
      );
    }
    case 'nonoptional':
    case 'readonly': {
      const inner = def.innerType;
      return inner ? (
        <Editor schema={inner} value={value} onChange={onChange} />
      ) : (
        <span />
      );
    }
    case 'literal':
      return <span>{String(def.values?.[0] ?? '')}</span>;
    case 'enum': {
      const options = def.entries ? Object.values(def.entries) : [];
      return (
        <Select
          value={String(value ?? '')}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          options={options.map((option) => String(option))}
        />
      );
    }
    case 'string':
      return (
        <Input
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    case 'number':
    case 'int':
      return (
        <Input
          type="number"
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === '' ? undefined : Number(next));
          }}
        />
      );
    case 'boolean':
      return (
        <label>
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => {
              onChange(event.target.checked);
            }}
          />{' '}
          Enabled
        </label>
      );
    case 'object': {
      const shape = def.shape ?? {};
      const record = value && typeof value === 'object' ? value : {};
      return (
        <div className="phase3-form-grid">
          {Object.entries(shape).map(([key, child]) => (
            <Field key={key} label={label(key)}>
              <Editor
                schema={child}
                value={(record as Record<string, unknown>)[key]}
                onChange={(next) => {
                  onChange({ ...(record as object), [key]: next });
                }}
              />
            </Field>
          ))}
        </div>
      );
    }
    case 'tuple': {
      const items = def.items ?? [];
      const list = Array.isArray(value) ? value : [];
      return (
        <div className="phase3-form-grid">
          {items.map((item, index) => (
            <Field key={index} label={`Value ${String(index + 1)}`}>
              <Editor
                schema={item}
                value={list[index]}
                onChange={(next) => {
                  const copy = [...list];
                  copy[index] = next;
                  onChange(copy);
                }}
              />
            </Field>
          ))}
        </div>
      );
    }
    case 'array': {
      const element = def.element ?? z.unknown();
      const list = Array.isArray(value) ? value : [];
      return (
        <div className="phase3-stack">
          {list.map((item, index) => (
            <fieldset key={index}>
              <legend>Item {index + 1}</legend>
              <Editor
                schema={element}
                value={item}
                onChange={(next) => {
                  const copy = [...list];
                  copy[index] = next;
                  onChange(copy);
                }}
              />
              <Button
                type="button"
                secondary
                onClick={() => {
                  onChange(list.filter((_, at) => at !== index));
                }}
              >
                Remove
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            secondary
            onClick={() => {
              onChange([...list, seed(element)]);
            }}
          >
            Add item
          </Button>
        </div>
      );
    }
    case 'union': {
      const options = def.options ?? [];
      const discriminator = def.discriminator;
      if (discriminator) {
        const current =
          value && typeof value === 'object'
            ? (value as Record<string, unknown>)[discriminator]
            : undefined;
        const matched = options.find((option) => {
          const literal = defOf(option).shape?.[discriminator];
          return defOf(literal ?? z.unknown()).values?.[0] === current;
        });
        return (
          <div className="phase3-stack">
            <Field label={label(discriminator)}>
              <Select
                value={String(current ?? '')}
                onChange={(event) => {
                  const next = options.find((option) => {
                    const literal = defOf(option).shape?.[discriminator];
                    return (
                      String(
                        defOf(literal ?? z.unknown()).values?.[0] ?? '',
                      ) === event.target.value
                    );
                  });
                  if (next) onChange(seed(next));
                }}
              >
                <option value="">Choose type</option>
                {options.map((option) => {
                  const literal = defOf(option).shape?.[discriminator];
                  const optionValue = String(
                    defOf(literal ?? z.unknown()).values?.[0] ?? '',
                  );
                  return (
                    <option key={optionValue} value={optionValue}>
                      {label(optionValue)}
                    </option>
                  );
                })}
              </Select>
            </Field>
            {matched && (
              <Editor schema={matched} value={value} onChange={onChange} />
            )}
          </div>
        );
      }
      const literalOptions = options.every(
        (option) => defOf(option).type === 'literal',
      );
      if (literalOptions) {
        const choices = options.map(
          (option) => defOf(option).values?.[0],
        ) as (string | number | boolean | null | undefined)[];
        return (
          <Select
            value={String(value ?? '')}
            onChange={(event) => {
              const next = choices.find(
                (choice) => String(choice) === event.target.value,
              );
              onChange(next);
            }}
            options={choices.map((choice) => String(choice))}
          />
        );
      }
      return (
        <Select
          value={String(
            options.findIndex(
              (option) => option.safeParse(value).success,
            ) || 0,
          )}
          onChange={(event) => {
            onChange(seed(options[Number(event.target.value)] ?? z.unknown()));
          }}
          options={options.map((_, index) => `Option ${String(index + 1)}`)}
        />
      );
    }
    default:
      return <span>{JSON.stringify(value)}</span>;
  }
}

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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const parsed = sportProfileSchema.safeParse(profile.profile);
    if (parsed.success) setDraft(parsed.data);
    else setError('Stored profile is missing required values; fix via API');
  }, [profile]);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const valid = sportProfileSchema.parse(draft);
      await apiPatch(
        `/sports/orgs/${orgId}/${profile.id}`,
        { expectedVersion: profile.version, profile: valid },
        response,
      );
      await onSaved();
    } catch (cause) {
      setError(
        cause instanceof z.ZodError
          ? cause.issues
              .slice(0, 3)
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')
          : cause instanceof Error
            ? cause.message
            : 'Profile could not be saved',
      );
    } finally {
      setBusy(false);
    }
  };
  const sectionSchema = (sportProfileSchema.shape as Record<string, z.ZodType>)[
    section
  ];
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
              setSection(event.target.value as Section);
            }}
          >
            {sections.map((name) => (
              <option key={name} value={name}>
                {label(name)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset>
        <legend>{label(section)}</legend>
        {sectionSchema && (
          <Editor
            schema={sectionSchema}
            value={draft[section]}
            onChange={(next) => {
              setDraft((current) => ({ ...current, [section]: next }));
            }}
          />
        )}
      </fieldset>
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
