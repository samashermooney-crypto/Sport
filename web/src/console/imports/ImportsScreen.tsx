import {
  importBatchListSchema,
  importBatchSchema,
  importKindSchema,
  importQueuedResponseSchema,
  importRowListSchema,
  mappingPresetListSchema,
  suggestMappingResponseSchema,
  rollbackBatchResponseSchema,
} from '@shared/schemas/imports';
import type { ImportBatch, ImportRow } from '@shared/schemas/imports';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost, apiPut, orgHeaders } from '../../api/client';
import { OrgShell } from '../../ui/OrgShell';
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

import './imports.css';

const KIND_LABELS: Record<string, string> = {
  people: 'People',
  households: 'Households',
  registrations: 'Registration history',
  teams: 'Teams',
  rosters: 'Rosters',
  schedule: 'Schedules',
  facilities: 'Facilities',
  credentials: 'Credentials (with zipped documents)',
  historical_payments: 'Historical payments',
  volunteer_hours: 'Volunteer hours',
};

const importFieldsSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      kind: importKindSchema,
      fields: z.array(
        z.strictObject({
          key: z.string(),
          label: z.string(),
          required: z.boolean(),
          aliases: z.array(z.string()),
        }),
      ),
    }),
  ),
});

type FieldDef = { key: string; label: string; required: boolean };

export function ImportsScreen({ orgId }: { orgId: string }): React.JSX.Element {
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const fields = useQuery({
    queryKey: ['imports', 'kinds'],
    queryFn: () => apiGet('/imports/kinds', importFieldsSchema),
  });
  const batches = useQuery({
    queryKey: ['imports', orgId, 'batches'],
    queryFn: () =>
      apiGet('/imports/batches', importBatchListSchema, orgHeaders(orgId)),
    refetchInterval: 3000,
  });
  return (
    <OrgShell orgId={orgId}>
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
            fieldDefs={fields.data?.items ?? []}
            onClose={() => {
              setActiveBatchId(null);
            }}
          />
        ) : (
          <>
            <NewImportCard
              orgId={orgId}
              kinds={fields.data?.items.map((item) => item.kind) ?? []}
              onCreated={setActiveBatchId}
            />
            <Card>
              <h2>Import history</h2>
              <DataTable
                columns={[
                  { key: 'file', label: 'File', render: (b) => b.fileName },
                  {
                    key: 'type',
                    label: 'Type',
                    render: (b) => KIND_LABELS[b.kind] ?? b.kind,
                  },
                  {
                    key: 'rows',
                    label: 'Rows',
                    render: (b) =>
                      `${String(b.rowCount)} (${String(b.errorCount)} errors)`,
                  },
                  {
                    key: 'status',
                    label: 'Status',
                    render: (b) => <Badge>{b.status}</Badge>,
                  },
                  {
                    key: 'created',
                    label: 'Created',
                    sort: (b) => b.createdAt,
                    render: (b) => new Date(b.createdAt).toLocaleString(),
                  },
                  {
                    key: 'open',
                    label: '',
                    render: (b) => (
                      <Button
                        secondary
                        onClick={() => {
                          setActiveBatchId(b.id);
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
    </OrgShell>
  );
}

function NewImportCard({
  orgId,
  kinds,
  onCreated,
}: {
  orgId: string;
  kinds: string[];
  onCreated: (batchId: string) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState('people');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
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
        `/api/v1/imports/batches?kind=${kind}&name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'X-Athlentry-Request': '1',
            'X-Athlentry-Org': orgId,
            'Content-Type': 'application/octet-stream',
          },
          body: file,
        },
      );
      const json: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          (json as { message?: string }).message ?? 'Upload failed',
        );
      const batch = importBatchSchema.parse(json);
      await queryClient.invalidateQueries({
        queryKey: ['imports', orgId],
      });
      onCreated(batch.id);
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
        Upload a CSV, Excel, or ZIP file. Not sure of the format?{' '}
        <a href={`/api/v1/imports/templates/${kind}.csv`} download>
          Download the {KIND_LABELS[kind] ?? kind} template
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
              label: KIND_LABELS[item] ?? item,
            }))}
            onChange={(event) => {
              setKind(event.target.value);
            }}
          />
        </Field>
        <Field label="File">
          <input
            ref={fileRef}
            type="file"
            className="ui-input"
            accept=".csv,.xlsx,.zip,.txt"
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
  fieldDefs: { kind: string; fields: FieldDef[] }[];
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const batch = useQuery({
    queryKey: ['imports', orgId, 'batch', batchId],
    queryFn: () =>
      apiGet(
        `/imports/batches/${batchId}`,
        importBatchSchema,
        orgHeaders(orgId),
      ),
    refetchInterval: (query) =>
      ['validating', 'committing', 'uploaded'].includes(
        query.state.data?.status ?? '',
      )
        ? 1500
        : false,
  });
  const rows = useQuery({
    queryKey: ['imports', orgId, 'batch', batchId, 'rows'],
    queryFn: () =>
      apiGet(
        `/imports/batches/${batchId}/rows?limit=200`,
        importRowListSchema,
        orgHeaders(orgId),
      ),
    enabled: Boolean(batch.data && batch.data.status !== 'uploaded'),
  });
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['imports', orgId] }),
      queryClient.invalidateQueries({
        queryKey: ['imports', orgId, 'batch', batchId],
      }),
      queryClient.invalidateQueries({
        queryKey: ['imports', orgId, 'batch', batchId, 'rows'],
      }),
    ]);
  const validate = useMutation({
    mutationFn: () =>
      apiPost(
        `/imports/batches/${batchId}/validate`,
        {},
        importQueuedResponseSchema,
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: invalidate,
  });
  const commit = useMutation({
    mutationFn: () =>
      apiPost(
        `/imports/batches/${batchId}/commit`,
        {},
        importQueuedResponseSchema,
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: invalidate,
  });
  const rollback = useMutation({
    mutationFn: () =>
      apiPost(
        `/imports/batches/${batchId}/rollback`,
        {},
        rollbackBatchResponseSchema,
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: invalidate,
  });
  if (!batch.data) {
    return (
      <Card>
        <p role="status">Loading import…</p>
      </Card>
    );
  }
  const current = batch.data;
  const fields =
    fieldDefs.find((item) => item.kind === current.kind)?.fields ?? [];
  return (
    <>
      <Card>
        <div className="imports-batch-header">
          <div>
            <h2>{current.fileName}</h2>
            <p>
              {KIND_LABELS[current.kind] ?? current.kind} ·{' '}
              {String(current.rowCount)} rows · <Badge>{current.status}</Badge>
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
          fields={fields}
          onSaved={() => void invalidate()}
        />
      )}
      {['mapped', 'validating', 'validated', 'committing'].includes(
        current.status,
      ) && (
        <Card>
          <h2>Validate</h2>
          <p>
            Athlentry checks every row and flags duplicates before anything is
            written.
          </p>
          <Button
            onClick={() => {
              validate.mutate();
            }}
            disabled={validate.isPending || current.status === 'validating'}
          >
            {current.status === 'validating' ? 'Validating…' : 'Validate rows'}
          </Button>
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
            skipped; a batch record tracks everything created so you can roll
            back.
          </p>
          <Button
            onClick={() => {
              commit.mutate();
            }}
            disabled={commit.isPending}
          >
            Commit import
          </Button>
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
            . If the results are wrong, roll back — records edited since the
            import are left untouched.
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
        </Card>
      )}
      {current.status === 'rolled_back' && (
        <Card>
          <h2>Rolled back</h2>
          <p>Everything this import created has been removed.</p>
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
  const [mapping, setMapping] = useState<Record<string, string | null>>(() => ({
    ...(batch.mapping?.columns ?? {}),
  }));
  const [presetName, setPresetName] = useState('');
  const [error, setError] = useState('');
  const presets = useQuery({
    queryKey: ['imports', orgId, 'presets', batch.kind],
    queryFn: () =>
      apiGet(
        `/imports/presets?kind=${batch.kind}`,
        mappingPresetListSchema,
        orgHeaders(orgId),
      ),
  });
  const suggest = useQuery({
    queryKey: ['imports', orgId, 'suggest', batch.id],
    queryFn: () =>
      apiGet(
        `/imports/batches/${batch.id}/suggest-mapping`,
        suggestMappingResponseSchema,
        orgHeaders(orgId),
      ),
  });
  const effective =
    Object.keys(mapping).length > 0
      ? mapping
      : (suggest.data?.mapping.columns ?? {});
  const save = useMutation({
    mutationFn: () =>
      apiPut(
        `/imports/batches/${batch.id}/mapping`,
        {
          mapping: { columns: effective },
          ...(presetName ? { savePresetAs: presetName } : {}),
        },
        importBatchSchema,
        orgHeaders(orgId),
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
  return (
    <Card>
      <h2>Map columns</h2>
      <p>
        Match each Athlentry field to a column in {batch.fileName}.
        {presets.data && presets.data.items.length > 0 && (
          <>
            {' '}
            Saved presets:{' '}
            {presets.data.items.map((preset) => (
              <Button
                key={preset.id}
                secondary
                onClick={() => {
                  setMapping({ ...preset.mapping.columns });
                }}
              >
                {preset.name}
              </Button>
            ))}
          </>
        )}
      </p>
      <div className="imports-mapping-grid">
        {fields.map((field) => (
          <Field
            key={field.key}
            label={`${field.label}${field.required ? ' *' : ''}`}
          >
            <Select
              value={effective[field.key] ?? ''}
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
          placeholder="e.g. LeagueApps members export"
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
        Save mapping
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
  rows: ImportRow[];
  onDecided: () => void;
}): React.JSX.Element {
  const decide = useMutation({
    mutationFn: (input: { rowId: string; action: string }) =>
      apiPost(
        `/imports/batches/${batch.id}/decisions`,
        { decisions: [{ rowId: input.rowId, action: input.action }] },
        z.object({}),
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: onDecided,
  });
  const decideAll = useMutation({
    mutationFn: (action: string) =>
      apiPost(
        `/imports/batches/${batch.id}/decisions`,
        {
          decisions: rows.map((row) => ({
            rowId: row.id,
            action,
          })),
        },
        z.object({}),
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: onDecided,
  });
  const duplicates = rows.filter((row) => row.duplicates.length > 0);
  return (
    <Card>
      <h2>
        Review rows ({String(rows.length)}
        {batch.rowCount > rows.length ? ` of ${String(batch.rowCount)}` : ''})
      </h2>
      {duplicates.length > 0 && (
        <div className="imports-bulk">
          <p>{String(duplicates.length)} possible duplicates found.</p>
          <Button
            secondary
            onClick={() => {
              decideAll.mutate('skip');
            }}
          >
            Skip all duplicates
          </Button>
          <Button
            secondary
            onClick={() => {
              decideAll.mutate('create');
            }}
          >
            Create all anyway
          </Button>
        </div>
      )}
      <DataTable
        columns={[
          {
            key: 'row',
            label: '#',
            render: (row) => String(row.rowNumber),
          },
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
            label: 'Duplicates',
            render: (row) =>
              row.duplicates.length === 0
                ? '—'
                : `${String(row.duplicates.length)} match(es)`,
          },
          {
            key: 'action',
            label: 'Action',
            render: (row) => (
              <Select
                aria-label={`Action for row ${String(row.rowNumber)}`}
                value={row.action}
                options={['create', 'update', 'merge', 'skip'].map(
                  (action) => ({ value: action, label: action }),
                )}
                onChange={(event) => {
                  decide.mutate({
                    rowId: row.id,
                    action: event.target.value,
                  });
                }}
              />
            ),
          },
        ]}
        rows={rows}
        empty="No rows."
      />
    </Card>
  );
}
