import {
  importBatchCreateSchema,
  importBatchListSchema,
  importBatchPreviewSchema,
  importBatchSchema,
  importKindSchema,
  importMappingPresetListSchema,
  importMappingPresetSchema,
} from '@shared/schemas/imports';
import type { ImportKind } from '@shared/schemas/imports';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Papa from 'papaparse';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router';

import { apiGet, apiPost } from '../api/client';
import { AuthFrame, ErrorBox } from '../ui/auth';
import {
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
} from '../ui/primitives';

import { PeopleShell } from './PeopleConsole';

interface ImportField {
  key: string;
  label: string;
  aliases: string[];
  required?: boolean;
}

const FIELDS: Record<ImportKind, ImportField[]> = {
  people: [
    { key: 'firstName', label: 'First name', aliases: ['first name', 'given name', 'first'], required: true },
    { key: 'lastName', label: 'Last name', aliases: ['last name', 'family name', 'surname', 'last'], required: true },
    { key: 'dateOfBirth', label: 'Date of birth', aliases: ['date of birth', 'birth date', 'dob', 'birthday'], required: true },
    { key: 'email', label: 'Email', aliases: ['email', 'email address'] },
    { key: 'phone', label: 'Phone', aliases: ['phone', 'mobile', 'telephone'] },
    { key: 'gender', label: 'Gender', aliases: ['gender', 'sex'] },
    { key: 'graduationYear', label: 'Graduation year', aliases: ['graduation year', 'grad year'] },
    { key: 'schoolName', label: 'School', aliases: ['school', 'school name'] },
    { key: 'householdName', label: 'Household', aliases: ['household', 'family', 'household name'] },
    { key: 'emergencyContactName', label: 'Emergency contact name', aliases: ['emergency contact', 'emergency contact name'] },
    { key: 'emergencyContactPhone', label: 'Emergency contact phone', aliases: ['emergency phone', 'emergency contact phone'] },
  ],
  households: [
    { key: 'householdName', label: 'Household name', aliases: ['household', 'household name', 'family'], required: true },
  ],
  guardians: [
    { key: 'guardianEmail', label: 'Guardian email', aliases: ['guardian email', 'parent email', 'adult email'], required: true },
    { key: 'personEmail', label: 'Person email', aliases: ['person email', 'athlete email', 'player email'] },
    { key: 'personFirstName', label: 'Person first name', aliases: ['person first name', 'athlete first name', 'player first name'], required: true },
    { key: 'personLastName', label: 'Person last name', aliases: ['person last name', 'athlete last name', 'player last name'], required: true },
    { key: 'personDateOfBirth', label: 'Person date of birth', aliases: ['person dob', 'athlete dob', 'player dob', 'date of birth'], required: true },
  ],
  emergency_contacts: [
    { key: 'personEmail', label: 'Person email', aliases: ['person email', 'athlete email', 'player email'] },
    { key: 'personFirstName', label: 'Person first name', aliases: ['person first name', 'athlete first name', 'player first name'], required: true },
    { key: 'personLastName', label: 'Person last name', aliases: ['person last name', 'athlete last name', 'player last name'], required: true },
    { key: 'personDateOfBirth', label: 'Person date of birth', aliases: ['person dob', 'athlete dob', 'player dob', 'date of birth'], required: true },
    { key: 'contactName', label: 'Contact name', aliases: ['contact name', 'emergency contact'], required: true },
    { key: 'relationship', label: 'Relationship', aliases: ['relationship', 'relation'] },
    { key: 'contactPhone', label: 'Contact phone', aliases: ['contact phone', 'emergency phone', 'phone'], required: true },
    { key: 'priority', label: 'Priority', aliases: ['priority', 'order'] },
  ],
};

const DUPLICATE_STRATEGIES = [
  { value: 'skip', label: 'Skip duplicates' },
  { value: 'update', label: 'Update matching profiles' },
  { value: 'merge', label: 'Merge into matching profiles' },
  { value: 'create', label: 'Create separate profiles' },
];

function normalizedHeader(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

function suggestMapping(
  kind: ImportKind,
  headers: string[],
): Record<string, string> {
  const byNormalized = new Map(headers.map((header) => [normalizedHeader(header), header]));
  return Object.fromEntries(
    FIELDS[kind].map((field) => {
      const candidates = [field.label, field.key, ...field.aliases];
      const found = candidates
        .map((candidate) => byNormalized.get(normalizedHeader(candidate)))
        .find((candidate) => candidate !== undefined);
      return [field.key, found ?? ''];
    }),
  );
}

async function readImportFile(file: File): Promise<{ content: string; headers: string[] }> {
  if (file.size > 10 * 1024 * 1024)
    throw new Error('Choose a file smaller than 10 MB.');
  let content: string;
  if (file.name.toLowerCase().endsWith('.xlsx')) {
    const { Workbook } = await import('exceljs');
    const workbook = new Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error('The spreadsheet has no worksheet.');
    if (worksheet.rowCount > 5001)
      throw new Error('Files are limited to 5,000 data rows.');
    const rows: string[][] = [];
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        values[column - 1] = cell.text;
      });
      rows.push(values);
    });
    content = Papa.unparse(rows);
  } else if (file.name.toLowerCase().endsWith('.csv')) {
    content = await file.text();
  } else {
    throw new Error('Choose a CSV or XLSX file.');
  }
  if (new Blob([content]).size > 10 * 1024 * 1024)
    throw new Error('The converted file is larger than 10 MB.');
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    preview: 1,
  });
  const headers = parsed.meta.fields ?? [];
  if (headers.length === 0 || parsed.data.length === 0)
    throw new Error('The file must contain a header row and at least one data row.');
  return { content, headers };
}

export function ImportsConsole(): React.JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  const client = useQueryClient();
  const [kind, setKind] = useState<ImportKind>('people');
  const [filename, setFilename] = useState('');
  const [content, setContent] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [duplicateStrategy, setDuplicateStrategy] = useState('skip');
  const [preview, setPreview] = useState<
    | (typeof importBatchPreviewSchema)['__output']
    | null
  >(null);
  const [presetName, setPresetName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const batchesPath = `/imports/orgs/${String(orgId)}/batches`;
  const batches = useQuery({
    queryKey: ['imports', orgId, 'batches'],
    queryFn: () => apiGet(batchesPath, importBatchListSchema),
    enabled: Boolean(orgId),
  });
  const presetsPath = `/imports/orgs/${String(orgId)}/presets?kind=${kind}`;
  const presets = useQuery({
    queryKey: ['imports', orgId, 'presets', kind],
    queryFn: () => apiGet(presetsPath, importMappingPresetListSchema),
    enabled: Boolean(orgId),
  });
  const fields = useMemo(() => FIELDS[kind], [kind]);

  if (!orgId)
    return (
      <AuthFrame>
        <h1>Organization unavailable</h1>
      </AuthFrame>
    );

  async function submitPreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!content || !filename) {
      setError('Choose a file before previewing it.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = importBatchCreateSchema.parse({
        kind,
        filename,
        content,
        mapping,
        duplicateStrategy: kind === 'people' ? duplicateStrategy : 'skip',
      });
      const result = await apiPost(batchesPath, body, importBatchPreviewSchema);
      setPreview(result);
      await client.invalidateQueries({ queryKey: ['imports', orgId, 'batches'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The file could not be previewed.');
    } finally {
      setBusy(false);
    }
  }

  async function commitBatch() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const batch = await apiPost(
        `${batchesPath}/${preview.batch.id}/commit`,
        {},
        importBatchSchema,
      );
      setPreview((current) => (current ? { ...current, batch } : current));
      await client.invalidateQueries({ queryKey: ['imports', orgId, 'batches'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The import could not be committed.');
    } finally {
      setBusy(false);
    }
  }

  async function rollbackBatch() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const batch = await apiPost(
        `${batchesPath}/${preview.batch.id}/rollback`,
        {},
        importBatchSchema,
      );
      setPreview((current) => (current ? { ...current, batch } : current));
      await client.invalidateQueries({ queryKey: ['imports', orgId, 'batches'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The import could not be rolled back.');
    } finally {
      setBusy(false);
    }
  }

  async function savePreset() {
    if (!presetName.trim()) {
      setError('Enter a name for this mapping preset.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await apiPost(
        `/imports/orgs/${orgId}/presets`,
        { kind, name: presetName.trim(), mapping },
        importMappingPresetSchema,
      );
      setPresetName('');
      await client.invalidateQueries({ queryKey: ['imports', orgId, 'presets', kind] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The mapping could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PeopleShell orgId={orgId}>
      <main className="console-home">
        <PageHeader
          kicker="PEOPLE"
          title="Import records"
          description="Map a CSV or XLSX export, review row-level validation, then commit or roll back the batch."
        />
        <ErrorBox error={error} />
        <Card>
          <form onSubmit={(event) => void submitPreview(event)}>
            <Field label="Import records">
              <Select
                value={kind}
                options={importKindSchema.options.map((value) => ({
                  value,
                  label: value.replaceAll('_', ' '),
                }))}
                onChange={(event) => {
                  const next = importKindSchema.parse(event.target.value);
                  setKind(next);
                  setMapping(suggestMapping(next, headers));
                  setPreview(null);
                }}
              />
            </Field>
            <Field label="CSV or XLSX file" required hint="Maximum 10 MB and 5,000 data rows.">
              <Input
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setBusy(true);
                  setError('');
                  setPreview(null);
                  void readImportFile(file)
                    .then(({ content: nextContent, headers: nextHeaders }) => {
                      setFilename(file.name);
                      setContent(nextContent);
                      setHeaders(nextHeaders);
                      setMapping(suggestMapping(kind, nextHeaders));
                    })
                    .catch((cause: unknown) => {
                      setFilename('');
                      setContent('');
                      setHeaders([]);
                      setError(cause instanceof Error ? cause.message : 'The file could not be read.');
                    })
                    .finally(() => setBusy(false));
                }}
              />
            </Field>
            {filename && <p>Selected: {filename}</p>}
            {presets.data && presets.data.items.length > 0 && (
              <Field label="Saved mapping">
                <Select
                  value=""
                  options={[
                    { value: '', label: 'Choose a saved mapping' },
                    ...presets.data.items.map((preset) => ({
                      value: preset.id,
                      label: preset.name,
                    })),
                  ]}
                  onChange={(event) => {
                    const preset = presets.data?.items.find(
                      (item) => item.id === event.target.value,
                    );
                    if (preset) setMapping(preset.mapping);
                  }}
                />
              </Field>
            )}
            {fields.map((field) => (
              <Field
                key={field.key}
                label={field.label}
                required={field.required}
              >
                <Select
                  value={mapping[field.key] ?? ''}
                  options={[
                    { value: '', label: 'Not mapped' },
                    ...headers.map((header) => ({ value: header, label: header })),
                  ]}
                  onChange={(event) =>
                    setMapping((current) => ({
                      ...current,
                      [field.key]: event.target.value,
                    }))
                  }
                />
              </Field>
            ))}
            {kind === 'people' && (
              <Field label="Duplicate handling">
                <Select
                  value={duplicateStrategy}
                  options={DUPLICATE_STRATEGIES}
                  onChange={(event) => setDuplicateStrategy(event.target.value)}
                />
              </Field>
            )}
            <Button type="submit" disabled={busy || !content}>
              {busy ? 'Working…' : 'Preview import'}
            </Button>
          </form>
          {headers.length > 0 && (
            <div className="form-row">
              <Field label="Preset name">
                <Input
                  value={presetName}
                  onChange={(event) => setPresetName(event.target.value)}
                />
              </Field>
              <Button type="button" secondary disabled={busy} onClick={() => void savePreset()}>
                Save mapping
              </Button>
            </div>
          )}
        </Card>

        {preview && (
          <Card>
            <h2>Batch preview</h2>
            <p>
              {preview.batch.filename} · {preview.batch.stats.total} rows ·{' '}
              {preview.batch.status}
            </p>
            <ul>
              <li>{preview.batch.stats.create} to create</li>
              <li>{preview.batch.stats.update} to update</li>
              <li>{preview.batch.stats.merge} to merge</li>
              <li>{preview.batch.stats.skip} to skip</li>
              <li>{preview.batch.stats.invalid} invalid</li>
            </ul>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Row</th><th>Action</th><th>Issues</th></tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 50).map((row) => (
                    <tr key={row.rowNumber}>
                      <td>{row.rowNumber}</td>
                      <td>{row.action}</td>
                      <td>{row.issues.map((issue) => issue.message).join('; ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rows.length > 50 && <p>Showing the first 50 rows.</p>}
            {preview.batch.status === 'preview' && (
              <Button type="button" disabled={busy || preview.batch.stats.create + preview.batch.stats.update + preview.batch.stats.merge === 0} onClick={() => void commitBatch()}>
                Commit valid rows
              </Button>
            )}
            {preview.batch.status === 'committed' && (
              <Button type="button" secondary disabled={busy} onClick={() => void rollbackBatch()}>
                Roll back untouched rows
              </Button>
            )}
          </Card>
        )}

        <Card>
          <h2>Recent imports</h2>
          {batches.isPending && <p role="status">Loading batches…</p>}
          {batches.isError && <ErrorBox error="Import batches could not be loaded." />}
          {batches.data?.items.map((batch) => (
            <p key={batch.id}>
              <Button
                type="button"
                secondary
                onClick={() => {
                  setBusy(true);
                  setError('');
                  void apiGet(`${batchesPath}/${batch.id}`, importBatchPreviewSchema)
                    .then(setPreview)
                    .catch((cause: unknown) =>
                      setError(cause instanceof Error ? cause.message : 'Batch could not be loaded.'),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {batch.filename} · {batch.status} · {batch.stats.total} rows
              </Button>
            </p>
          ))}
          {batches.data?.items.length === 0 && <p>No imports yet.</p>}
        </Card>
      </main>
    </PeopleShell>
  );
}
