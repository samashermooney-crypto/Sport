import {
  formDefinitionListSchema,
  formDefinitionSchema,
} from '@shared/schemas/forms';
import type { FormDefinitionCreate, FormSchema } from '@shared/schemas/forms';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';

import { apiGet, apiPatch, apiPost } from '../api/client';
import { useToast } from '../ui/app-feedback';
import { ErrorBox } from '../ui/auth';
import { ConfirmDialog } from '../ui/overlays';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../ui/primitives';

import { PeopleShell } from './PeopleConsole';

const fieldTypes = [
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'multiselect',
  'checkbox',
  'file',
  'signature',
  'phone',
  'email',
  'address',
  'heading',
  'paragraph',
] as const;

const blankDefinition = (): FormDefinitionCreate => ({
  name: '',
  scope: 'person_profile',
  schema: { fields: [] },
});

function initialField(index: number): FormSchema['fields'][number] {
  const label = `Question ${String(index + 1)}`;
  return {
    key: `question_${String(index + 1)}`,
    type: 'text',
    label: { en: label, es: label },
    required: false,
    options: [],
    tier: 'public',
    appliesTo: ['athlete'],
    profileScoped: false,
    askEverySeason: false,
  };
}

export function FormsConsole(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const client = useQueryClient();
  const notify = useToast();
  const definitions = useQuery({
    queryKey: ['forms', orgId, 'console'],
    queryFn: () => apiGet(`/forms/orgs/${orgId}`, formDefinitionListSchema),
    enabled: Boolean(orgId),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = definitions.data?.items.find(
    (item) => item.id === selectedId,
  );
  const [definition, setDefinition] =
    useState<FormDefinitionCreate>(blankDefinition);
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [publishConfirmationOpen, setPublishConfirmationOpen] = useState(false);

  function edit(id: string): void {
    const item = definitions.data?.items.find((row) => row.id === id);
    if (!item) return;
    setSelectedId(id);
    setEditVersion(item.version);
    setDefinition({ name: item.name, scope: item.scope, schema: item.schema });
    setError('');
    setPublishConfirmationOpen(false);
  }

  function newDefinition(): void {
    setSelectedId(null);
    setEditVersion(null);
    setDefinition(blankDefinition());
    setError('');
    setPublishConfirmationOpen(false);
  }

  function setField<K extends keyof FormSchema['fields'][number]>(
    index: number,
    key: K,
    value: FormSchema['fields'][number][K],
  ): void {
    setDefinition((current) => ({
      ...current,
      schema: {
        fields: current.schema.fields.map((field, at) =>
          at === index ? { ...field, [key]: value } : field,
        ),
      },
    }));
  }

  async function save(): Promise<void> {
    if (!orgId) return;
    const wasEditing = selectedId !== null;
    setBusy(true);
    setError('');
    try {
      const saved = selectedId
        ? await apiPatch(
            `/forms/orgs/${orgId}/${selectedId}`,
            { ...definition, expectedVersion: editVersion },
            formDefinitionSchema,
          )
        : await apiPost(
            `/forms/orgs/${orgId}`,
            definition,
            formDefinitionSchema,
          );
      setSelectedId(saved.id);
      setEditVersion(saved.version);
      setDefinition({
        name: saved.name,
        scope: saved.scope,
        schema: saved.schema,
      });
      await client.invalidateQueries({ queryKey: ['forms', orgId, 'console'] });
      notify(
        wasEditing ? 'Form draft saved.' : 'Form created as a draft.',
        'success',
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Form could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function publish(): Promise<void> {
    if (!orgId || !selectedId || editVersion === null) return;
    setBusy(true);
    setError('');
    try {
      const saved = await apiPost(
        `/forms/orgs/${orgId}/${selectedId}/publish`,
        { expectedVersion: editVersion },
        formDefinitionSchema,
      );
      setSelectedId(saved.id);
      setEditVersion(saved.version);
      await client.invalidateQueries({ queryKey: ['forms', orgId, 'console'] });
      setPublishConfirmationOpen(false);
      notify('Form version published.', 'success');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Form could not be published.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <PeopleShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="PEOPLE"
          title="Forms"
          description="Create and publish versioned person forms."
        />
        <ErrorBox error={error} />
        <div className="ui-showcase-content">
          <Card>
            <div className="ui-showcase-inline">
              <h2>Form library</h2>
              <Button type="button" onClick={newDefinition}>
                New form
              </Button>
            </div>
            {definitions.isPending && <p role="status">Loading forms…</p>}
            {definitions.isError && (
              <ErrorState
                title="Forms could not be loaded"
                onRetry={() => {
                  void definitions.refetch();
                }}
              >
                Your saved forms are unchanged.
              </ErrorState>
            )}
            <ul>
              {definitions.data?.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="ui-link"
                    onClick={() => {
                      edit(item.id);
                    }}
                  >
                    {item.name} · v{item.version} ·{' '}
                    {item.publishedAt ? 'Published' : 'Draft'}
                  </button>
                </li>
              ))}
            </ul>
            {definitions.data?.items.length === 0 && (
              <EmptyState title="No forms yet">
                Create a form for profiles, registrations, or another program
                workflow.
              </EmptyState>
            )}
          </Card>
          <Card>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <h2>
                {selected
                  ? `${selected.name} · v${String(editVersion)}`
                  : 'New form'}
              </h2>
              <Field label="Form name" required>
                <Input
                  value={definition.name}
                  maxLength={120}
                  onChange={(event) => {
                    setDefinition((current) => ({
                      ...current,
                      name: event.target.value,
                    }));
                  }}
                />
              </Field>
              <Field label="Form scope" required>
                <Select
                  value={definition.scope}
                  onChange={(event) => {
                    setDefinition((current) => ({
                      ...current,
                      scope: event.target
                        .value as FormDefinitionCreate['scope'],
                    }));
                  }}
                >
                  {[
                    'person_profile',
                    'registration',
                    'team_entry',
                    'volunteer',
                    'evaluation',
                    'incident',
                    'custom',
                  ].map((scope) => (
                    <option key={scope} value={scope}>
                      {scope.replaceAll('_', ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
              <h3>Fields</h3>
              {definition.schema.fields.map((field, index) => (
                <Card
                  key={`${field.key}-${String(index)}`}
                  aria-label={`Field ${String(index + 1)}`}
                >
                  <Field label="Field key" required>
                    <Input
                      value={field.key}
                      onChange={(event) => {
                        setField(index, 'key', event.target.value);
                      }}
                      pattern="[a-z][a-zA-Z0-9_]{0,63}"
                    />
                  </Field>
                  <Field label="Field type" required>
                    <Select
                      value={field.type}
                      onChange={(event) => {
                        setField(
                          index,
                          'type',
                          event.target.value as typeof field.type,
                        );
                      }}
                    >
                      {fieldTypes.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="English label" required>
                    <Input
                      value={field.label.en}
                      onChange={(event) => {
                        setField(index, 'label', {
                          ...field.label,
                          en: event.target.value,
                        });
                      }}
                      maxLength={200}
                    />
                  </Field>
                  <Field label="Spanish label" required>
                    <Input
                      value={field.label.es}
                      onChange={(event) => {
                        setField(index, 'label', {
                          ...field.label,
                          es: event.target.value,
                        });
                      }}
                      maxLength={200}
                    />
                  </Field>
                  {['select', 'multiselect'].includes(field.type) && (
                    <Field label="Options (one per line)" required>
                      <Textarea
                        value={field.options.join('\n')}
                        onChange={(event) => {
                          setField(
                            index,
                            'options',
                            event.target.value
                              .split('\n')
                              .map((option) => option.trim())
                              .filter(Boolean),
                          );
                        }}
                      />
                    </Field>
                  )}
                  <Field label="Sensitivity tier">
                    <Select
                      value={field.tier}
                      onChange={(event) => {
                        setField(
                          index,
                          'tier',
                          event.target.value as typeof field.tier,
                        );
                      }}
                    >
                      {['public', 'sensitive', 'restricted'].map((tier) => (
                        <option key={tier} value={tier}>
                          {tier}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Visible when field equals (optional)">
                    <Input
                      value={
                        field.visibility
                          ? `${field.visibility.fieldKey}=${String(field.visibility.equals)}`
                          : ''
                      }
                      onChange={(event) => {
                        const [fieldKey, ...parts] =
                          event.target.value.split('=');
                        const equals = parts.join('=');
                        setField(
                          index,
                          'visibility',
                          fieldKey && equals ? { fieldKey, equals } : undefined,
                        );
                      }}
                      placeholder="consent=yes"
                    />
                  </Field>
                  <label className="ui-showcase-choice">
                    <Checkbox
                      checked={field.required}
                      onChange={(event) => {
                        setField(index, 'required', event.target.checked);
                      }}
                    />{' '}
                    Required
                  </label>
                  <label className="ui-showcase-choice">
                    <Checkbox
                      checked={field.profileScoped}
                      onChange={(event) => {
                        setField(index, 'profileScoped', event.target.checked);
                      }}
                    />{' '}
                    Reuse in future forms
                  </label>
                  <Button
                    type="button"
                    secondary
                    onClick={() => {
                      setDefinition((current) => ({
                        ...current,
                        schema: {
                          fields: current.schema.fields.filter(
                            (_, at) => at !== index,
                          ),
                        },
                      }));
                    }}
                  >
                    Remove field
                  </Button>
                </Card>
              ))}
              <div className="ui-showcase-inline">
                <Button
                  type="button"
                  secondary
                  onClick={() => {
                    setDefinition((current) => ({
                      ...current,
                      schema: {
                        fields: [
                          ...current.schema.fields,
                          initialField(current.schema.fields.length),
                        ],
                      },
                    }));
                  }}
                >
                  Add field
                </Button>
                <Button
                  type="submit"
                  disabled={busy || !definition.name.trim()}
                >
                  {busy ? 'Saving…' : 'Save draft'}
                </Button>
                {selectedId && selected?.publishedAt === null && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setPublishConfirmationOpen(true);
                    }}
                  >
                    Publish version
                  </Button>
                )}
              </div>
            </form>
          </Card>
        </div>
        <ConfirmDialog
          title="Publish this form version?"
          open={publishConfirmationOpen}
          confirmLabel="Publish version"
          busy={busy}
          onCancel={() => {
            setPublishConfirmationOpen(false);
          }}
          onConfirm={() => {
            void publish();
          }}
        >
          New form responses will use this version. Existing responses keep the
          version they were submitted against.
        </ConfirmDialog>
      </main>
    </PeopleShell>
  );
}
