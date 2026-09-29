import {
  formAnswersSchema,
  formDefinitionListSchema,
  formResponseSchema,
} from '@shared/schemas/forms';
import type { FormSchema } from '@shared/schemas/forms';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useParams } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPost } from '../api/client';
import { ErrorBox } from '../ui/auth';
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../ui/primitives';
import { AppShell } from '../ui/shell';

type Answers = Record<string, unknown>;
const formUploadSchema = z.strictObject({
  fileId: z.uuid(),
  uploadUrl: z.string(),
});
const formUploadCompleteSchema = z.strictObject({ id: z.uuid() });

function documentMime(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  return '';
}

function FormFileField({
  field,
  label,
  value,
  orgId,
  personId,
  onChange,
}: {
  field: FormSchema['fields'][number];
  label: string;
  value: unknown;
  orgId: string;
  personId: string;
  onChange: (value: unknown) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function upload(file: File | undefined): Promise<void> {
    if (!file) return;
    const mime = documentMime(file);
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mime)) {
      setError('Choose a PDF, JPEG, or PNG document.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const begin = await apiPost(
        '/files/uploads',
        {
          purpose: 'document',
          mime,
          bytes: file.size,
          ownerType: 'person_document',
          ownerId: personId,
          sensitivity: 'restricted',
        },
        formUploadSchema,
        undefined,
        { 'X-Athlentry-Org': orgId },
      );
      const local = begin.uploadUrl.startsWith('/');
      const uploaded = await fetch(begin.uploadUrl, {
        method: 'PUT',
        body: file,
        credentials: local ? 'include' : 'omit',
        headers: {
          'Content-Type': mime,
          ...(local
            ? { 'X-Athlentry-Request': '1', 'X-Athlentry-Org': orgId }
            : {}),
        },
      });
      if (!uploaded.ok) throw new Error('Document upload failed.');
      await apiPost(
        `/files/uploads/${begin.fileId}/complete`,
        {},
        formUploadCompleteSchema,
        undefined,
        { 'X-Athlentry-Org': orgId },
      );
      onChange(begin.fileId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Document could not be uploaded.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Field label={label} required={field.required}>
      <Input
        type="file"
        accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
        disabled={busy}
        onChange={(event) => void upload(event.currentTarget.files?.[0])}
      />
      {busy && <small role="status">Uploading document…</small>}
      {typeof value === 'string' && <small>Document attached.</small>}
      {error && <small role="alert">{error}</small>}
    </Field>
  );
}

function FormField({
  field,
  language,
  value,
  orgId,
  personId,
  onChange,
}: {
  field: FormSchema['fields'][number];
  language: 'en' | 'es';
  value: unknown;
  orgId: string;
  personId: string;
  onChange: (value: unknown) => void;
}): React.JSX.Element | null {
  const label = field.label[language];
  if (field.type === 'heading') return <h3>{label}</h3>;
  if (field.type === 'paragraph') return <p>{label}</p>;
  if (field.type === 'checkbox')
    return (
      <Field label={label} required={field.required}>
        <Checkbox
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
      </Field>
    );
  if (field.type === 'textarea' || field.type === 'address')
    return (
      <Field label={label} required={field.required}>
        <Textarea
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          maxLength={4000}
        />
      </Field>
    );
  if (field.type === 'select')
    return (
      <Field label={label} required={field.required}>
        <Select
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => {
            onChange(event.target.value || undefined);
          }}
        >
          <option value="">Choose an option</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
    );
  if (field.type === 'multiselect')
    return (
      <Field label={label} required={field.required}>
        <Select
          multiple
          value={Array.isArray(value) ? value.map(String) : []}
          onChange={(event) => {
            onChange(
              Array.from(
                event.currentTarget.selectedOptions,
                (item) => item.value,
              ),
            );
          }}
        >
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
    );
  if (field.type === 'file')
    return (
      <FormFileField
        field={field}
        label={label}
        value={value}
        orgId={orgId}
        personId={personId}
        onChange={onChange}
      />
    );
  const inputType =
    field.type === 'number'
      ? 'number'
      : field.type === 'date'
        ? 'date'
        : field.type === 'email'
          ? 'email'
          : field.type === 'phone'
            ? 'tel'
            : 'text';
  return (
    <Field label={label} required={field.required}>
      <Input
        type={inputType}
        value={
          typeof value === 'string' || typeof value === 'number' ? value : ''
        }
        onChange={(event) => {
          onChange(
            field.type === 'number' && event.target.value
              ? Number(event.target.value)
              : event.target.value || undefined,
          );
        }}
      />
    </Field>
  );
}

export function FamilyForms(): React.JSX.Element {
  const { orgId = '', personId = '' } = useParams();
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage?.startsWith('es') ? 'es' : 'en';
  const forms = useQuery({
    queryKey: ['forms', orgId, personId, 'family'],
    queryFn: () =>
      apiGet(
        `/forms/orgs/${orgId}/person?personId=${personId}`,
        formDefinitionListSchema,
      ),
    enabled: Boolean(orgId && personId),
  });
  const [answers, setAnswers] = useState<Record<string, Answers>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [busyForm, setBusyForm] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function submit(formId: string): Promise<void> {
    const form = forms.data?.items.find((item) => item.id === formId);
    if (!form || !orgId || !personId) return;
    setBusyForm(formId);
    setError('');
    try {
      const source = answers[form.id] ?? {};
      const visibleAnswers = Object.fromEntries(
        form.schema.fields
          .filter(
            (field) =>
              field.type !== 'heading' &&
              field.type !== 'paragraph' &&
              (!field.visibility ||
                source[field.visibility.fieldKey] ===
                  field.visibility.equals) &&
              Object.hasOwn(source, field.key),
          )
          .map((field) => [field.key, source[field.key]]),
      );
      const result = await apiPost(
        `/forms/orgs/${orgId}/responses`,
        {
          formDefinitionId: form.id,
          subjectType: 'person',
          subjectId: personId,
          answers: visibleAnswers,
        },
        formResponseSchema,
      );
      setSaved((current) => ({ ...current, [form.id]: result.submittedAt }));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Form could not be submitted.',
      );
    } finally {
      setBusyForm(null);
    }
  }

  async function reuseAnswers(formId: string): Promise<void> {
    if (!orgId || !personId) return;
    setError('');
    try {
      const reusable = await apiGet(
        `/forms/orgs/${orgId}/${formId}/reuse?personId=${personId}`,
        formAnswersSchema,
      );
      setAnswers((current) => ({ ...current, [formId]: reusable.answers }));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Saved answers are unavailable.',
      );
    }
  }

  return (
    <AppShell
      orgName="Athlentry"
      navigation={[
        { label: 'Family', items: [{ label: 'Family', to: '/me/family' }] },
      ]}
      mobileTabs={[
        { label: 'Family', to: '/me/family' },
        { label: 'Account', to: '/me' },
      ]}
    >
      <main className="console-home">
        <PageHeader
          kicker="FAMILY"
          title="Forms"
          description="Complete published forms for this family profile."
        />
        <p>
          <RouterLink to="/me/family">Back to family</RouterLink>
        </p>
        <ErrorBox error={error} />
        {forms.isPending && <p role="status">Loading forms…</p>}
        {forms.isError && (
          <Card>
            <p>Forms are unavailable.</p>
          </Card>
        )}
        {forms.data?.items.length === 0 && (
          <Card>
            <p>There are no published forms for this profile.</p>
          </Card>
        )}
        {forms.data?.items.map((form) => {
          const current = answers[form.id] ?? {};
          const submittedAt = saved[form.id];
          return (
            <Card key={form.id}>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(form.id);
                }}
              >
                <h2>{form.name}</h2>
                <p>Version {form.version}</p>
                {form.schema.fields.map((field) => {
                  const visible =
                    !field.visibility ||
                    current[field.visibility.fieldKey] ===
                      field.visibility.equals;
                  if (!visible) return null;
                  return (
                    <FormField
                      key={field.key}
                      field={field}
                      language={language}
                      value={current[field.key]}
                      orgId={orgId}
                      personId={personId}
                      onChange={(value) => {
                        setAnswers((old) => ({
                          ...old,
                          [form.id]: {
                            ...(old[form.id] ?? {}),
                            [field.key]: value,
                          },
                        }));
                      }}
                    />
                  );
                })}
                <div className="ui-showcase-inline">
                  <Button
                    type="button"
                    secondary
                    onClick={() => void reuseAnswers(form.id)}
                  >
                    Use saved answers
                  </Button>
                  <Button type="submit" disabled={busyForm === form.id}>
                    {busyForm === form.id ? 'Submitting…' : 'Submit form'}
                  </Button>
                </div>
                {submittedAt && (
                  <p role="status">
                    Submitted {new Date(submittedAt).toLocaleString()}.
                  </p>
                )}
              </form>
            </Card>
          );
        })}
      </main>
    </AppShell>
  );
}
