import {
  waiverDocumentListSchema,
  waiverDocumentSchema,
} from '@shared/schemas/waivers';
import type { WaiverDocumentCreate } from '@shared/schemas/waivers';
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
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '../ui/primitives';

import { PeopleShell } from './PeopleConsole';

const blankWaiver = (): WaiverDocumentCreate => ({
  name: '',
  bodyText: '',
  requires: 'guardian_if_minor',
  renewal: 'every_registration',
});

export function WaiversConsole(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const client = useQueryClient();
  const notify = useToast();
  const documents = useQuery({
    queryKey: ['waivers', orgId, 'console'],
    queryFn: () => apiGet(`/waivers/orgs/${orgId}`, waiverDocumentListSchema),
    enabled: Boolean(orgId),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = documents.data?.items.find((item) => item.id === selectedId);
  const [document, setDocument] = useState<WaiverDocumentCreate>(blankWaiver);
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [publishConfirmationOpen, setPublishConfirmationOpen] = useState(false);
  const [retireConfirmationOpen, setRetireConfirmationOpen] = useState(false);

  function edit(id: string): void {
    const item = documents.data?.items.find((row) => row.id === id);
    if (!item) return;
    setSelectedId(id);
    setEditVersion(item.version);
    setDocument({
      name: item.name,
      bodyText: item.bodyText,
      requires: item.requires,
      renewal: item.renewal,
    });
    setError('');
    setPublishConfirmationOpen(false);
    setRetireConfirmationOpen(false);
  }

  function create(): void {
    setSelectedId(null);
    setEditVersion(null);
    setDocument(blankWaiver());
    setError('');
    setPublishConfirmationOpen(false);
    setRetireConfirmationOpen(false);
  }

  async function save(): Promise<void> {
    if (!orgId) return;
    const wasEditing = selectedId !== null;
    setBusy(true);
    setError('');
    try {
      const saved = selectedId
        ? await apiPatch(
            `/waivers/orgs/${orgId}/${selectedId}`,
            { ...document, expectedVersion: editVersion },
            waiverDocumentSchema,
          )
        : await apiPost(
            `/waivers/orgs/${orgId}`,
            document,
            waiverDocumentSchema,
          );
      setSelectedId(saved.id);
      setEditVersion(saved.version);
      setDocument({
        name: saved.name,
        bodyText: saved.bodyText,
        requires: saved.requires,
        renewal: saved.renewal,
      });
      await client.invalidateQueries({
        queryKey: ['waivers', orgId, 'console'],
      });
      notify(
        wasEditing ? 'Waiver draft saved.' : 'Waiver created as a draft.',
        'success',
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Waiver could not be saved.',
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
        `/waivers/orgs/${orgId}/${selectedId}/publish`,
        { expectedVersion: editVersion },
        waiverDocumentSchema,
      );
      setEditVersion(saved.version);
      await client.invalidateQueries({
        queryKey: ['waivers', orgId, 'console'],
      });
      setPublishConfirmationOpen(false);
      notify('Waiver version published.', 'success');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Waiver could not be published.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function retire(): Promise<void> {
    if (!orgId || !selectedId || editVersion === null) return;
    setBusy(true);
    setError('');
    try {
      const saved = await apiPost(
        `/waivers/orgs/${orgId}/${selectedId}/retire`,
        { expectedVersion: editVersion },
        waiverDocumentSchema,
      );
      setEditVersion(saved.version);
      await client.invalidateQueries({
        queryKey: ['waivers', orgId, 'console'],
      });
      setRetireConfirmationOpen(false);
      notify(
        'Waiver retired. Existing signatures remain available.',
        'success',
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Waiver could not be retired.',
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
          title="Waivers"
          description="Review, version, and publish organization waiver documents."
        />
        <ErrorBox error={error} />
        <Card>
          <div className="ui-showcase-inline">
            <h2>Waiver library</h2>
            <Button type="button" onClick={create}>
              New waiver
            </Button>
          </div>
          {documents.isPending && <p role="status">Loading waivers…</p>}
          {documents.isError && (
            <ErrorState
              title="Waivers could not be loaded"
              onRetry={() => {
                void documents.refetch();
              }}
            >
              Your saved waivers are unchanged.
            </ErrorState>
          )}
          <ul>
            {documents.data?.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="ui-link"
                  onClick={() => {
                    edit(item.id);
                  }}
                >
                  {item.name} · v{item.version} ·{' '}
                  {item.retiredAt
                    ? 'Retired'
                    : item.publishedAt
                      ? 'Published'
                      : item.templateUnreviewed
                        ? 'Review required'
                        : 'Draft'}
                </button>
              </li>
            ))}
          </ul>
          {documents.data?.items.length === 0 && (
            <EmptyState title="No waivers yet">
              Add organization-reviewed text before publishing a waiver for
              families to sign.
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
                : 'New waiver'}
            </h2>
            <Field label="Waiver name" required>
              <Input
                value={document.name}
                maxLength={160}
                onChange={(event) => {
                  setDocument((current) => ({
                    ...current,
                    name: event.target.value,
                  }));
                }}
              />
            </Field>
            <Field
              label="Waiver text"
              required
              hint="Use the organization's reviewed text. Publishing is blocked while the default template is unreviewed."
            >
              <Textarea
                value={document.bodyText}
                maxLength={40_000}
                rows={12}
                onChange={(event) => {
                  setDocument((current) => ({
                    ...current,
                    bodyText: event.target.value,
                  }));
                }}
              />
            </Field>
            <Field label="Who must sign" required>
              <Select
                value={document.requires}
                onChange={(event) => {
                  setDocument((current) => ({
                    ...current,
                    requires: event.target
                      .value as WaiverDocumentCreate['requires'],
                  }));
                }}
              >
                <option value="guardian_if_minor">
                  Guardian for minors; participant for adults
                </option>
                <option value="participant">Adult participant only</option>
                <option value="both">
                  Adult participant and verified guardian
                </option>
              </Select>
              {document.requires === 'both' && (
                <small>
                  Both an adult participant and a different verified guardian
                  must sign. This option cannot be used for minors.
                </small>
              )}
            </Field>
            <Field label="Renewal" required>
              <Select
                value={document.renewal}
                onChange={(event) => {
                  setDocument((current) => ({
                    ...current,
                    renewal: event.target
                      .value as WaiverDocumentCreate['renewal'],
                  }));
                }}
              >
                <option value="every_registration">Every registration</option>
                <option value="annual_season">Each season</option>
                <option value="once">Once</option>
              </Select>
            </Field>
            <div className="ui-showcase-inline">
              <Button
                type="submit"
                disabled={
                  busy ||
                  !document.name.trim() ||
                  document.bodyText.trim().length < 20
                }
              >
                {busy ? 'Saving…' : 'Save draft'}
              </Button>
              {selectedId &&
                selected?.publishedAt === null &&
                !selected.templateUnreviewed && (
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
              {selectedId &&
                selected?.publishedAt !== null &&
                selected?.retiredAt === null && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setRetireConfirmationOpen(true);
                    }}
                  >
                    Retire published waiver
                  </Button>
                )}
            </div>
          </form>
        </Card>
        <ConfirmDialog
          title="Publish this waiver version?"
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
          Families can sign this version after publishing. The previous
          published version will be retired, and its signature records stay
          available.
        </ConfirmDialog>
        <ConfirmDialog
          title="Retire this published waiver?"
          open={retireConfirmationOpen}
          confirmLabel="Retire waiver"
          busy={busy}
          onCancel={() => {
            setRetireConfirmationOpen(false);
          }}
          onConfirm={() => {
            void retire();
          }}
        >
          Families will no longer be able to sign this waiver. Existing
          signature records and signed PDFs will remain available.
        </ConfirmDialog>
      </main>
    </PeopleShell>
  );
}
