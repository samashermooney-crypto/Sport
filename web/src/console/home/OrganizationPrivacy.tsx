import {
  createPrivacyRequestSchema,
  privacyRequestListSchema,
  privacyRequestSchema,
  privacySubjectExportSchema,
  retentionPolicySchema,
  updatePrivacyRequestSchema,
} from '@shared/schemas/exports';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import {
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
} from '../../ui/primitives';

const emptyBody = {};

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function OrganizationPrivacy({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const base = `/exports/orgs/${encodeURIComponent(orgId)}`;
  const requestsKey = ['orgs', orgId, 'privacy-requests'] as const;
  const requests = useQuery({
    queryKey: requestsKey,
    queryFn: () => apiGet(`${base}/privacy-requests`, privacyRequestListSchema),
  });
  const policy = useQuery({
    queryKey: ['orgs', orgId, 'retention-policy'],
    queryFn: () => apiGet(`${base}/retention-policy`, retentionPolicySchema),
  });
  const [kind, setKind] = useState<'access' | 'correction' | 'deletion'>(
    'access',
  );
  const [subjectType, setSubjectType] = useState<'person' | 'household'>(
    'person',
  );
  const [subjectId, setSubjectId] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    await queryClient.invalidateQueries({
      queryKey: requestsKey,
      refetchType: 'none',
    });
    await requests.refetch();
  }

  async function createRequest(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('create');
    setError('');
    setNotice('');
    const parsed = createPrivacyRequestSchema.safeParse({
      kind,
      subjectType,
      subjectId: subjectId.trim(),
    });
    if (!parsed.success) {
      setError('Enter a valid person or household ID.');
      setBusy('');
      return;
    }
    try {
      const result = await apiPost(
        `${base}/privacy-requests`,
        parsed.data,
        privacyRequestSchema,
      );
      setSubjectId('');
      await refresh();
      setNotice(`Privacy request created (${result.id}).`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The privacy request could not be created.',
      );
    } finally {
      setBusy('');
    }
  }

  async function transition(
    requestId: string,
    version: number,
    status: 'in_review' | 'approved' | 'completed' | 'rejected',
  ) {
    setBusy(requestId);
    setError('');
    setNotice('');
    const resolutionNote = notes[requestId]?.trim() ?? '';
    const parsed = updatePrivacyRequestSchema.safeParse({
      status,
      version,
      ...(resolutionNote ? { resolutionNote } : {}),
    });
    if (!parsed.success) {
      setError(
        'Add a resolution note before completing or rejecting a request.',
      );
      setBusy('');
      return;
    }
    try {
      await apiPatch(
        `${base}/privacy-requests/${encodeURIComponent(requestId)}`,
        parsed.data,
        privacyRequestSchema,
      );
      await refresh();
      setNotice(`Privacy request ${status.replace('_', ' ')}.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The privacy request could not be updated.',
      );
    } finally {
      setBusy('');
    }
  }

  async function downloadAccessExport(requestId: string) {
    setBusy(requestId);
    setError('');
    setNotice('');
    try {
      const result = await apiPost(
        `${base}/privacy-requests/${encodeURIComponent(requestId)}/access-export`,
        emptyBody,
        privacySubjectExportSchema,
      );
      const blob = new Blob([`${JSON.stringify(result, null, 2)}\n`], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `privacy-access-${result.subjectType}-${result.subjectId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice('The approved subject access package was downloaded.');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The subject access package could not be created.',
      );
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="organization-privacy" aria-labelledby="privacy-title">
      <header className="console-home__header">
        <div>
          <p className="console-home__eyebrow">ORGANIZATION DATA</p>
          <h2 id="privacy-title">Privacy requests and retention</h2>
          <p>
            Review access, correction, and deletion requests. Deletion keeps
            required financial, waiver, compliance, and safety records while
            anonymizing eligible identity data.
          </p>
        </div>
      </header>

      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <Card className="organization-privacy__card">
        <h3>Create a privacy request</h3>
        <form
          className="organization-privacy__form"
          onSubmit={(event) => {
            void createRequest(event);
          }}
        >
          <Field label="Request type" required>
            <Select
              aria-label="Request type"
              value={kind}
              options={[
                { value: 'access', label: 'Access export' },
                { value: 'correction', label: 'Correction review' },
                { value: 'deletion', label: 'Deletion and anonymization' },
              ]}
              onChange={(event) => {
                setKind(event.target.value as typeof kind);
              }}
            />
          </Field>
          <Field label="Subject type" required>
            <Select
              aria-label="Subject type"
              value={subjectType}
              options={[
                { value: 'person', label: 'Person' },
                { value: 'household', label: 'Household' },
              ]}
              onChange={(event) => {
                setSubjectType(event.target.value as typeof subjectType);
              }}
            />
          </Field>
          <Field
            label="Subject ID"
            required
            hint="Use the person or household ID from its organization record."
          >
            <Input
              aria-label="Subject ID"
              required
              value={subjectId}
              onChange={(event) => {
                setSubjectId(event.target.value);
              }}
            />
          </Field>
          <Button type="submit" disabled={busy !== ''}>
            Create request
          </Button>
        </form>
      </Card>

      <div className="console-home__cards organization-privacy__layout">
        <Card className="organization-privacy__card">
          <h3>Privacy request queue</h3>
          {requests.isPending ? (
            <p role="status">Loading privacy requests…</p>
          ) : requests.isError ? (
            <p role="alert">Privacy requests are unavailable.</p>
          ) : requests.data.items.length === 0 ? (
            <p>No privacy requests have been created.</p>
          ) : (
            <div className="organization-privacy__requests">
              {requests.data.items.map((request) => (
                <article
                  className="organization-privacy__request"
                  key={request.id}
                >
                  <h4>
                    {request.kind} · {request.subjectType}
                  </h4>
                  <dl>
                    <div>
                      <dt>Subject</dt>
                      <dd>{request.subjectId}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{request.status.replace('_', ' ')}</dd>
                    </div>
                    <div>
                      <dt>Created</dt>
                      <dd>{dateLabel(request.createdAt)}</dd>
                    </div>
                  </dl>
                  {request.resolutionNote && <p>{request.resolutionNote}</p>}
                  {request.status !== 'completed' &&
                    request.status !== 'rejected' && (
                      <>
                        <Field
                          label="Resolution note"
                          hint="Required when rejecting or completing the request."
                        >
                          <Textarea
                            aria-label={`Resolution note for ${request.id}`}
                            value={notes[request.id] ?? ''}
                            onChange={(event) => {
                              setNotes((current) => ({
                                ...current,
                                [request.id]: event.target.value,
                              }));
                            }}
                          />
                        </Field>
                        <div className="console-home__actions">
                          {request.status === 'pending' && (
                            <Button
                              secondary
                              disabled={busy !== ''}
                              onClick={() =>
                                void transition(
                                  request.id,
                                  request.version,
                                  'in_review',
                                )
                              }
                            >
                              Start review
                            </Button>
                          )}
                          {request.status === 'in_review' && (
                            <Button
                              secondary
                              disabled={busy !== ''}
                              onClick={() =>
                                void transition(
                                  request.id,
                                  request.version,
                                  'approved',
                                )
                              }
                            >
                              Approve
                            </Button>
                          )}
                          {request.status === 'approved' &&
                            request.kind === 'access' && (
                              <Button
                                secondary
                                disabled={busy !== ''}
                                onClick={() =>
                                  void downloadAccessExport(request.id)
                                }
                              >
                                Download subject access package
                              </Button>
                            )}
                          {request.status === 'approved' && (
                            <Button
                              disabled={busy !== ''}
                              onClick={() =>
                                void transition(
                                  request.id,
                                  request.version,
                                  'completed',
                                )
                              }
                            >
                              {request.kind === 'deletion'
                                ? 'Anonymize subject and complete'
                                : 'Complete request'}
                            </Button>
                          )}
                          {request.status !== 'approved' && (
                            <Button
                              secondary
                              disabled={busy !== ''}
                              onClick={() =>
                                void transition(
                                  request.id,
                                  request.version,
                                  'rejected',
                                )
                              }
                            >
                              Reject
                            </Button>
                          )}
                        </div>
                      </>
                    )}
                </article>
              ))}
            </div>
          )}
        </Card>

        <Card className="organization-privacy__card">
          <h3>Retention policy</h3>
          {policy.isPending ? (
            <p role="status">Loading retention policy…</p>
          ) : policy.isError ? (
            <p role="alert">Retention policy is unavailable.</p>
          ) : (
            <>
              <p>Policy version {policy.data.version}</p>
              <dl>
                <div>
                  <dt>Financial records</dt>
                  <dd>{policy.data.rules.financialRecordsYears} years</dd>
                </div>
                <div>
                  <dt>Waiver and safety records</dt>
                  <dd>
                    7 years after age 18 or 7 years after the event, whichever
                    is later
                  </dd>
                </div>
                <div>
                  <dt>Background check details</dt>
                  <dd>
                    Credential validity plus{' '}
                    {policy.data.rules.backgroundCheckValidityPlusYears} year
                  </dd>
                </div>
                <div>
                  <dt>Messages</dt>
                  <dd>{policy.data.rules.messagesYears} years</dd>
                </div>
                <div>
                  <dt>Evaluation scores</dt>
                  <dd>
                    {policy.data.rules.evaluationScoresYearsAfterEvent} years
                    after the event
                  </dd>
                </div>
                <div>
                  <dt>Expired sessions and tokens</dt>
                  <dd>{policy.data.rules.expiredTokensDays} days</dd>
                </div>
              </dl>
              <p>
                Retention rules are versioned and enforced by the weekly sweep.
              </p>
            </>
          )}
        </Card>
      </div>
    </section>
  );
}
