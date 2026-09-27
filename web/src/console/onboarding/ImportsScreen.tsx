import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  PageHeader,
  Select,
} from '../../ui/primitives';

import {
  importBatchListSchema,
  importBatchSchema,
  importFieldsSchema,
  importKindSchema,
  importPresetListSchema,
  importRowsSchema,
} from './imports-api';
import type { ImportBatch, ImportKind } from './imports-api';

import './imports.css';

const labels: Record<ImportKind, string> = {
  people: 'People',
  households: 'Households',
  registrations: 'Registration history',
  teams: 'Teams',
  rosters: 'Rosters',
  schedule: 'Schedules',
  facilities: 'Facilities',
  credentials: 'Credentials and documents',
  historical_payments: 'Historical payments',
  volunteer_hours: 'Volunteer hours',
};
const resultSchema = z.record(z.string(), z.unknown());
const queuedSchema = z.strictObject({ queued: z.boolean() });
const decisionSchema = z.strictObject({ updated: z.number() });
const skipSchema = z.strictObject({ skipped: z.number() });

type FieldDef = {
  key: string;
  label: string;
  required: boolean;
  aliases: string[];
};
type Choice = { action: 'create' | 'skip' };

function batchPath(orgId: string, batchId?: string): string {
  return `/imports/orgs/${orgId}/phase15/batches${batchId ? `/${batchId}` : ''}`;
}

function reverseColumns(
  columns: Record<string, string | null> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(columns ?? {}).flatMap(([header, field]) =>
      field ? [[field, header]] : [],
    ),
  );
}

function forwardColumns(
  columns: Record<string, string | null>,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(columns).flatMap(([field, header]) =>
      header ? [[header, field]] : [],
    ),
  );
}

function summaryCountLabels(
  summary: Record<string, unknown> | null,
  key: string,
): string[] {
  const value = summary?.[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return [];
  return Object.entries(value).flatMap(([name, count]) => {
    if (typeof count !== 'number' || count <= 0) return [];
    return [`${name} (${String(count)})`];
  });
}

export function ImportsScreen({ orgId }: { orgId: string }): React.JSX.Element {
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const fields = useQuery({
    queryKey: ['phase15-imports', orgId, 'kinds'],
    queryFn: () =>
      apiGet(`/imports/orgs/${orgId}/phase15/kinds`, importFieldsSchema),
  });
  const batches = useQuery({
    queryKey: ['phase15-imports', orgId, 'batches'],
    queryFn: () => apiGet(batchPath(orgId), importBatchListSchema),
    refetchInterval: 3000,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['phase15-imports', orgId] });

  return (
    <main className="imports-screen">
      <PageHeader
        title="Imports"
        kicker="DATA MIGRATION"
        description="Bring people, rosters, schedules and history in from spreadsheets."
      />
      {activeBatchId ? (
        <BatchWizard
          orgId={orgId}
          batchId={activeBatchId}
          fieldDefs={
            fields.data?.items.find(
              (entry) =>
                entry.kind ===
                batches.data?.items.find((item) => item.id === activeBatchId)
                  ?.kind,
            )?.fields ?? []
          }
          onClose={() => {
            setActiveBatchId(null);
            void refresh();
          }}
        />
      ) : (
        <>
          <NewImportCard
            orgId={orgId}
            kinds={fields.data?.items.map((entry) => entry.kind) ?? []}
            onCreated={(id) => {
              setActiveBatchId(id);
              void refresh();
            }}
          />
          <Card>
            <h2>Import history</h2>
            <DataTable
              columns={[
                {
                  key: 'file',
                  label: 'File',
                  render: (batch) => batch.fileName,
                },
                {
                  key: 'type',
                  label: 'Type',
                  render: (batch) => labels[batch.kind],
                },
                {
                  key: 'rows',
                  label: 'Rows',
                  render: (batch) =>
                    `${String(batch.rowCount)} (${String(batch.errorCount)} errors)`,
                },
                {
                  key: 'status',
                  label: 'Status',
                  render: (batch) => <Badge>{batch.status}</Badge>,
                },
                {
                  key: 'created',
                  label: 'Created',
                  sort: (batch) => batch.createdAt,
                  render: (batch) => new Date(batch.createdAt).toLocaleString(),
                },
                {
                  key: 'open',
                  label: '',
                  render: (batch) => (
                    <Button
                      secondary
                      onClick={() => {
                        setActiveBatchId(batch.id);
                      }}
                    >
                      Open
                    </Button>
                  ),
                },
              ]}
              rows={batches.data?.items ?? []}
              empty="No imports yet."
            />
          </Card>
        </>
      )}
    </main>
  );
}

function NewImportCard({
  orgId,
  kinds,
  onCreated,
}: {
  orgId: string;
  kinds: ImportKind[];
  onCreated: (batchId: string) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<ImportKind>('people');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a CSV, XLSX, or ZIP file first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/v1${batchPath(orgId)}?kind=${kind}&name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'X-Athlentry-Request': '1',
            'Content-Type': 'application/octet-stream',
          },
          body: file,
        },
      );
      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? (json.error as { message?: string }).message
            : undefined;
        throw new Error(message ?? 'Upload failed');
      }
      onCreated(importBatchSchema.parse(json).id);
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : 'Upload failed',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <h2>Start an import</h2>
      <p>
        Upload a CSV or Excel file. Credentials can include a ZIP of matching
        PDF or image documents.{' '}
        <a href={`/api/v1/imports/phase15/templates/${kind}.csv`} download>
          Download the {labels[kind]} template
        </a>
        , or{' '}
        <a href={`/console/orgs/${orgId}/help`}>
          ask for concierge import help
        </a>
        .
      </p>
      <div className="imports-new-row">
        <Field label="Import type">
          <Select
            value={kind}
            options={kinds.map((item) => ({
              value: item,
              label: labels[item],
            }))}
            onChange={(event) => {
              const parsed = importKindSchema.safeParse(event.target.value);
              if (parsed.success) setKind(parsed.data);
            }}
          />
        </Field>
        <Field label="File">
          <input
            ref={fileRef}
            type="file"
            className="ui-input"
            accept=".csv,.xlsx,.zip"
          />
        </Field>
        <Button onClick={() => void upload()} disabled={busy}>
          {busy ? 'Uploading…' : 'Upload'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="imports-error">
          {error}
        </p>
      )}
    </Card>
  );
}

function BatchWizard({
  orgId,
  batchId,
  fieldDefs,
  onClose,
}: {
  orgId: string;
  batchId: string;
  fieldDefs: FieldDef[];
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const path = batchPath(orgId, batchId);
  const batch = useQuery({
    queryKey: ['phase15-imports', orgId, 'batch', batchId],
    queryFn: () => apiGet(path, importBatchSchema),
    refetchInterval: (query) =>
      ['validating', 'committing'].includes(query.state.data?.status ?? '')
        ? 1500
        : false,
  });
  const batchStatus = batch.data?.status;
  useEffect(() => {
    if (!batchStatus || !['validating', 'committing'].includes(batchStatus))
      return;
    const events = new EventSource(`/api/v1${path}/events`, {
      withCredentials: true,
    });
    events.addEventListener('progress', () => {
      void queryClient.invalidateQueries({
        queryKey: ['phase15-imports', orgId, 'batch', batchId],
      });
    });
    return () => {
      events.close();
    };
  }, [batchStatus, batchId, orgId, path, queryClient]);
  const rows = useQuery({
    queryKey: ['phase15-imports', orgId, 'rows', batchId],
    queryFn: () => apiGet(`${path}/rows?limit=200`, importRowsSchema),
    enabled: Boolean(
      batch.data &&
      ['validated', 'committed', 'rolled_back'].includes(batch.data.status),
    ),
  });
  const invalidate = async () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['phase15-imports', orgId, 'batches'],
      }),
      queryClient.invalidateQueries({
        queryKey: ['phase15-imports', orgId, 'batch', batchId],
      }),
      queryClient.invalidateQueries({
        queryKey: ['phase15-imports', orgId, 'rows', batchId],
      }),
    ]);
  const validate = useMutation({
    mutationFn: () => apiPost(`${path}/validate`, {}, queuedSchema),
    onSuccess: invalidate,
  });
  const commit = useMutation({
    mutationFn: () => apiPost(`${path}/commit`, {}, queuedSchema),
    onSuccess: invalidate,
  });
  const rollback = useMutation({
    mutationFn: () => apiPost(`${path}/rollback`, {}, resultSchema),
    onSuccess: invalidate,
  });
  if (!batch.data)
    return (
      <Card>
        <p role="status">Loading import…</p>
      </Card>
    );
  const current = batch.data;
  const reversedRecords = summaryCountLabels(current.summary, 'reversed');
  const retainedRecords = summaryCountLabels(
    current.summary,
    'retained_records',
  );
  return (
    <>
      <Card>
        <div className="imports-batch-header">
          <div>
            <h2>{current.fileName}</h2>
            <p>
              {labels[current.kind]} · {String(current.rowCount)} rows ·{' '}
              <Badge>{current.status}</Badge>
            </p>
          </div>
          <Button secondary onClick={onClose}>
            Back to imports
          </Button>
        </div>
        {['validating', 'committing'].includes(current.status) && (
          <p role="status">
            Working… {String(current.progress.processed)} of{' '}
            {String(current.progress.total)} rows processed.
          </p>
        )}
      </Card>
      {current.status === 'uploaded' && (
        <MappingCard
          orgId={orgId}
          batch={current}
          fields={fieldDefs}
          onSaved={() => void invalidate()}
        />
      )}
      {['mapped', 'validating', 'validated'].includes(current.status) && (
        <Card>
          <h2>Validate</h2>
          <p>
            Every row is checked and possible duplicates are shown before
            anything is written.
          </p>
          <Button
            onClick={() => {
              validate.mutate();
            }}
            disabled={validate.isPending || current.status === 'validating'}
          >
            {validate.isPending ? 'Validating…' : 'Validate rows'}
          </Button>
          {validate.isError && (
            <p role="alert" className="imports-error">
              {validate.error.message}
            </p>
          )}
        </Card>
      )}
      {rows.data && rows.data.items.length > 0 && (
        <RowsCard
          orgId={orgId}
          batch={current}
          rows={rows.data.items}
          onDecided={() => void invalidate()}
        />
      )}
      {current.status === 'validated' && (
        <Card>
          <h2>Commit</h2>
          <p>
            {String(current.rowCount - current.errorCount)} of{' '}
            {String(current.rowCount)} rows are ready. Rows with errors are
            skipped. The batch records its writes so you can roll it back.
          </p>
          <Button
            onClick={() => {
              commit.mutate();
            }}
            disabled={commit.isPending}
          >
            Commit import
          </Button>
          {commit.isError && (
            <p role="alert" className="imports-error">
              {commit.error.message}
            </p>
          )}
        </Card>
      )}
      {current.status === 'committed' && (
        <Card>
          <h2>Committed</h2>
          <p>
            This import committed{' '}
            {current.committedAt
              ? new Date(current.committedAt).toLocaleString()
              : 'recently'}
            . Records changed since the import are left untouched during
            rollback.
          </p>
          <Button
            secondary
            onClick={() => {
              rollback.mutate();
            }}
            disabled={rollback.isPending}
          >
            {rollback.isPending ? 'Rolling back…' : 'Roll back this import'}
          </Button>
          {rollback.isError && (
            <p role="alert" className="imports-error">
              {rollback.error.message}
            </p>
          )}
        </Card>
      )}
      {current.status === 'rolled_back' && (
        <Card>
          <h2>Rolled back</h2>
          <p>
            The import rollback has completed. Financial and compliance evidence
            remains retained.
          </p>
          {reversedRecords.length > 0 && (
            <p>Reversed: {reversedRecords.join(', ')}.</p>
          )}
          {retainedRecords.length > 0 && (
            <p role="status">
              Review retained records: {retainedRecords.join(', ')}.
            </p>
          )}
        </Card>
      )}
    </>
  );
}

function MappingCard({
  orgId,
  batch,
  fields,
  onSaved,
}: {
  orgId: string;
  batch: ImportBatch;
  fields: FieldDef[];
  onSaved: () => void;
}): React.JSX.Element {
  const [mapping, setMapping] = useState<Record<string, string | null>>(() =>
    reverseColumns(batch.mapping?.columns),
  );
  const [presetName, setPresetName] = useState('');
  const [error, setError] = useState('');
  const presets = useQuery({
    queryKey: ['phase15-imports', orgId, 'presets', batch.kind],
    queryFn: () =>
      apiGet(
        `/imports/orgs/${orgId}/phase15/presets?kind=${batch.kind}`,
        importPresetListSchema,
      ),
  });
  const save = useMutation({
    mutationFn: () =>
      apiPost(
        `/imports/orgs/${orgId}/phase15/batches/${batch.id}/mapping`,
        {
          mapping: { columns: forwardColumns(mapping) },
          ...(presetName.trim() ? { savePresetAs: presetName.trim() } : {}),
        },
        importBatchSchema,
      ),
    onSuccess: onSaved,
    onError: (mutationError) => {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : 'Could not save mapping',
      );
    },
  });
  const applyPreset = (columns: Record<string, string | null>) => {
    setMapping(reverseColumns(columns));
  };
  return (
    <Card>
      <h2>Map columns</h2>
      <p>Match each Athlentry field to a column in {batch.fileName}.</p>
      {presets.data && presets.data.items.length > 0 && (
        <div className="imports-bulk">
          <span>Saved presets: </span>
          {presets.data.items.map((preset) => (
            <Button
              key={preset.id}
              secondary
              onClick={() => {
                applyPreset(preset.mapping.columns);
              }}
            >
              {preset.name}
            </Button>
          ))}
        </div>
      )}
      <div className="imports-mapping-grid">
        {fields.map((field) => (
          <Field
            key={field.key}
            label={`${field.label}${field.required ? ' *' : ''}`}
          >
            <Select
              value={mapping[field.key] ?? ''}
              options={[
                { value: '', label: '— Not imported —' },
                ...batch.headers.map((header) => ({
                  value: header,
                  label: header,
                })),
              ]}
              onChange={(event) => {
                setMapping((current) => ({
                  ...current,
                  [field.key]: event.target.value || null,
                }));
              }}
            />
          </Field>
        ))}
      </div>
      <Field label="Save this mapping as a preset (optional)">
        <Input
          value={presetName}
          maxLength={120}
          onChange={(event) => {
            setPresetName(event.target.value);
          }}
          placeholder="e.g. Club roster export"
        />
      </Field>
      {error && (
        <p role="alert" className="imports-error">
          {error}
        </p>
      )}
      <Button
        onClick={() => {
          save.mutate();
        }}
        disabled={save.isPending}
      >
        {save.isPending ? 'Saving…' : 'Save mapping'}
      </Button>
    </Card>
  );
}

function RowsCard({
  orgId,
  batch,
  rows,
  onDecided,
}: {
  orgId: string;
  batch: ImportBatch;
  rows: z.infer<typeof importRowsSchema>['items'];
  onDecided: () => void;
}): React.JSX.Element {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const duplicates = rows.filter((row) => row.duplicates.length > 0);
  const decisions = useMutation({
    mutationFn: (
      items: { rowId: string; action: Choice['action']; targetId?: string }[],
    ) =>
      apiPost(
        `/imports/orgs/${orgId}/phase15/batches/${batch.id}/rows/decisions`,
        { decisions: items },
        decisionSchema,
      ),
    onSuccess: () => {
      setChoices({});
      onDecided();
    },
  });
  const skipAll = useMutation({
    mutationFn: () =>
      apiPost(
        `/imports/orgs/${orgId}/phase15/batches/${batch.id}/rows/skip-duplicates`,
        {},
        skipSchema,
      ),
    onSuccess: () => {
      setChoices({});
      onDecided();
    },
  });
  const changed = duplicates.flatMap((row) => {
    const choice = choices[row.id];
    if (!choice) return [];
    const originalAction = row.action === 'skip' ? 'skip' : 'create';
    if (choice.action === originalAction) return [];
    return [{ rowId: row.id, action: choice.action }];
  });
  return (
    <Card>
      <h2>
        Review rows ({String(rows.length)}
        {batch.rowCount > rows.length ? ` of ${String(batch.rowCount)}` : ''})
      </h2>
      {duplicates.length > 0 && (
        <div className="imports-bulk">
          <p>
            {String(duplicates.length)} possible duplicates on this page. Choose
            whether to create a new record or skip each row.
          </p>
          <Button
            secondary
            onClick={() => {
              skipAll.mutate();
            }}
            disabled={skipAll.isPending}
          >
            {skipAll.isPending ? 'Skipping…' : 'Skip all duplicates'}
          </Button>
          {changed.length > 0 && (
            <Button
              onClick={() => {
                decisions.mutate(changed);
              }}
              disabled={decisions.isPending}
            >
              {decisions.isPending ? 'Saving…' : 'Save row choices'}
            </Button>
          )}
        </div>
      )}
      {(decisions.isError || skipAll.isError) && (
        <p role="alert" className="imports-error">
          {decisions.error?.message ?? skipAll.error?.message}
        </p>
      )}
      <DataTable
        columns={[
          { key: 'row', label: '#', render: (row) => String(row.rowNumber) },
          {
            key: 'data',
            label: 'Data',
            render: (row) => Object.values(row.raw).slice(0, 4).join(' · '),
          },
          {
            key: 'issues',
            label: 'Issues',
            render: (row) =>
              row.issues.length === 0
                ? '—'
                : row.issues
                    .map((issue) => `${issue.level}: ${issue.message}`)
                    .join('; '),
          },
          {
            key: 'dupes',
            label: 'Possible matches',
            render: (row) =>
              row.duplicates.length === 0
                ? '—'
                : row.duplicates
                    .map(
                      (duplicate) =>
                        `${duplicate.name} (${duplicate.reasons.join(', ')})`,
                    )
                    .join('; '),
          },
          {
            key: 'action',
            label: 'Action',
            render: (row) => {
              if (row.duplicates.length === 0 || batch.status !== 'validated')
                return row.action;
              const current: Choice = choices[row.id] ?? {
                action: row.action === 'skip' ? 'skip' : 'create',
              };
              return (
                <Select
                  aria-label={`Action for row ${String(row.rowNumber)}`}
                  value={current.action}
                  options={[
                    { value: 'create', label: 'Create new' },
                    { value: 'skip', label: 'Skip row' },
                  ]}
                  onChange={(event) => {
                    setChoices((value) => ({
                      ...value,
                      [row.id]: {
                        action: event.target.value as Choice['action'],
                      },
                    }));
                  }}
                />
              );
            },
          },
        ]}
        rows={rows}
        empty="No rows."
      />
    </Card>
  );
}
