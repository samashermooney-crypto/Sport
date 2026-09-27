import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Link,
  QRCode,
  Select,
  Table,
  Textarea,
} from '../../ui';
import type { Column } from '../../ui';

const idSchema = z.uuid();
const dashboardSchema = z.object({
  pendingCredentials: z.number(),
  expiredCredentials: z.number(),
  activeOverrides: z.number(),
  pendingBackgroundChecks: z.number(),
  pendingClearances: z.number(),
  openIncidents: z.number(),
  activeInjuries: z.number(),
});
const credentialSchema = z.object({
  id: z.string(),
  personId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  credentialTypeId: z.string(),
  credentialName: z.string(),
  status: z.string(),
  identifierHint: z.string().nullable(),
  expiresOn: z.string().nullable(),
  fileId: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  version: z.number(),
});
const requirementSchema = z.object({
  id: z.string(),
  role: z.string(),
  credentialTypeId: z.string(),
  credentialName: z.string(),
  scopeType: z.string(),
  scopeId: z.string().nullable(),
  minimumAge: z.number(),
  active: z.boolean(),
  version: z.number(),
});
const typeSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  verification: z.string(),
  validity: z.union([
    z.object({ months: z.number() }),
    z.object({ expires_on_month_day: z.string() }),
    z.object({ never: z.literal(true) }),
  ]),
  blocks_activation: z.boolean(),
  renewal_reminder_days: z.array(z.number()),
  active: z.boolean(),
  version: z.number(),
});
const incidentSchema = z.object({
  id: z.string(),
  category: z.string(),
  occurredAt: z.string(),
  eventId: z.string().nullable(),
  reportedBy: z.string(),
  status: z.string(),
  restricted: z.boolean(),
  version: z.number(),
});
const clearanceSchema = z.object({
  id: z.string(),
  injuryReportId: z.string(),
  personId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  clearanceFileId: z.string(),
  providerName: z.string(),
  clearedOn: z.string(),
  reviewStatus: z.string(),
  version: z.number(),
});
const checkSchema = z.object({
  id: z.string(),
  personId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  provider: z.string(),
  package: z.string(),
  status: z.string(),
  resultSummary: z.string().nullable(),
  adjudication: z.string(),
  completedAt: z.string().nullable(),
  preAdverseNoticeAt: z.string().nullable(),
  adverseNoticeAt: z.string().nullable(),
  version: z.number(),
});
const injurySchema = z.object({
  id: z.string(),
  eventId: z.string().nullable(),
  occurredAt: z.string(),
  bodyPart: z.string().nullable(),
  injuryType: z.string().nullable(),
  suspectedConcussion: z.boolean(),
  description: z.string(),
  status: z.string(),
  version: z.number(),
});
const disputeSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  personId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  status: z.string(),
  submittedAt: z.string(),
  version: z.number(),
  statement: z.string(),
});
const cardSchema = z.object({
  id: z.string(),
  personId: z.string(),
  programId: z.string().nullable(),
  seasonId: z.string().nullable(),
  cardKind: z.string(),
  cardNumber: z.string(),
  status: z.string(),
  validUntil: z.string(),
  version: z.number(),
  token: z.string(),
  verificationUrl: z.string(),
});
const resultSchema = z.looseObject({ id: z.string() });
const emptySchema = z.looseObject({});

type Dashboard = z.infer<typeof dashboardSchema>;
type Credential = z.infer<typeof credentialSchema>;
type Incident = z.infer<typeof incidentSchema>;
type CardRow = z.infer<typeof cardSchema>;
type CredentialType = z.infer<typeof typeSchema>;
type CredentialTypeDraft = {
  name: string;
  description: string;
  validityMode: 'months' | 'expires_on_month_day' | 'never';
  months: string;
  monthDay: string;
  blocksActivation: boolean;
  renewalReminderDays: string;
  active: boolean;
};

function credentialTypeDraft(type: CredentialType): CredentialTypeDraft {
  return {
    name: type.name,
    description: type.description ?? '',
    validityMode:
      'months' in type.validity
        ? 'months'
        : 'expires_on_month_day' in type.validity
          ? 'expires_on_month_day'
          : 'never',
    months: 'months' in type.validity ? String(type.validity.months) : '12',
    monthDay:
      'expires_on_month_day' in type.validity
        ? type.validity.expires_on_month_day
        : '01-01',
    blocksActivation: type.blocks_activation,
    renewalReminderDays: type.renewal_reminder_days.join(', '),
    active: type.active,
  };
}

async function downloadRestrictedEvidence(orgId: string, fileId: string) {
  const response = await fetch(`/api/v1/files/${fileId}/content`, {
    credentials: 'include',
    headers: {
      'X-Athlentry-Org': orgId,
      'X-Athlentry-Request': '1',
    },
  });
  if (!response.ok)
    throw new Error('Restricted evidence is unavailable to this account.');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `restricted-evidence-${fileId}`;
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function orgPath(orgId: string, suffix: string): string {
  return `/compliance/organizations/${orgId}${suffix}`;
}

function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <p role="alert" className="field-error">
      {message}
    </p>
  ) : null;
}

function LoadState({ loading, error }: { loading: boolean; error: string }) {
  if (loading) return <p role="status">Loading safety records…</p>;
  return error ? <ErrorMessage message={error} /> : null;
}

function dashboardColumns(): Column<{
  id: string;
  label: string;
  value: number;
  to: string;
}>[] {
  return [
    {
      key: 'label',
      label: 'Area',
      render: (row) => <Link to={row.to}>{row.label}</Link>,
    },
    {
      key: 'value',
      label: 'Needs attention',
      render: (row) => (
        <Badge tone={row.value ? 'warn' : 'ok'}>{row.value}</Badge>
      ),
      sort: (row) => row.value,
    },
  ];
}

export function SafetyDashboard(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const [summary, setSummary] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!idSchema.safeParse(orgId).success) return;
    void apiGet(orgPath(orgId, '/dashboard'), dashboardSchema)
      .then(setSummary)
      .catch((reason: unknown) => {
        setError(
          reason instanceof Error
            ? reason.message
            : 'Safety dashboard could not be loaded.',
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, [orgId]);
  const rows = summary
    ? [
        {
          id: 'credentials',
          label: 'Credential reviews',
          value: summary.pendingCredentials,
          to: `/console/safety/${orgId}/review`,
        },
        {
          id: 'expired',
          label: 'Expired credentials',
          value: summary.expiredCredentials,
          to: `/console/safety/${orgId}/review`,
        },
        {
          id: 'checks',
          label: 'Background checks',
          value: summary.pendingBackgroundChecks,
          to: `/console/safety/${orgId}/background-checks`,
        },
        {
          id: 'clearances',
          label: 'Return to play reviews',
          value: summary.pendingClearances,
          to: `/console/safety/${orgId}/review`,
        },
        {
          id: 'incidents',
          label: 'Open incidents',
          value: summary.openIncidents,
          to: `/console/safety/${orgId}/incidents`,
        },
        {
          id: 'injuries',
          label: 'Active injuries',
          value: summary.activeInjuries,
          to: `/console/safety/${orgId}/injuries`,
        },
        {
          id: 'overrides',
          label: 'Active overrides',
          value: summary.activeOverrides,
          to: `/console/safety/${orgId}/requirements`,
        },
      ]
    : [];
  return (
    <main>
      <header>
        <h1>Safety and compliance</h1>
        <p>
          Review credentials, checks, injuries and incident reports for this
          organization.
        </p>
      </header>
      <LoadState loading={loading} error={error} />
      {summary && (
        <>
          <DataTable
            rows={rows}
            columns={dashboardColumns()}
            empty="No safety indicators are available."
          />
          <nav aria-label="Safety tasks">
            <ul>
              <li>
                <Link to={`/console/safety/${orgId}/requirements`}>
                  Credential types and requirements
                </Link>
              </li>
              <li>
                <Link to={`/console/safety/${orgId}/background-checks`}>
                  Background checks and disputes
                </Link>
              </li>
              <li>
                <Link to={`/console/safety/${orgId}/background-check-settings`}>
                  Background-check settings
                </Link>
              </li>
              <li>
                <Link to={`/console/safety/${orgId}/incidents`}>
                  Incident review
                </Link>
              </li>
              <li>
                <Link to={`/console/safety/${orgId}/cards`}>
                  Player and staff cards
                </Link>
              </li>
            </ul>
          </nav>
        </>
      )}
    </main>
  );
}

export function SafetyCredentialReviews(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const [rows, setRows] = useState<Credential[]>([]);
  const [clearances, setClearances] = useState<
    z.infer<typeof clearanceSchema>[]
  >([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const [credentials, clearanceRows] = await Promise.all([
      apiGet(
        orgPath(orgId, '/credentials/review-queue'),
        z.array(credentialSchema),
      ),
      apiGet(
        `/safety/organizations/${orgId}/clearances/review-queue`,
        z.array(clearanceSchema),
      ),
    ]);
    setRows(credentials);
    setClearances(clearanceRows);
  }, [orgId]);
  useEffect(() => {
    void refresh()
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Reviews could not be loaded.',
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, [refresh]);
  const reviewCredential = async (
    row: Credential,
    decision: 'approve' | 'reject',
  ) => {
    if (decision === 'reject' && (reasons[row.id]?.trim().length ?? 0) < 8) {
      setError(
        'Enter an explanation of at least eight characters before rejecting.',
      );
      return;
    }
    try {
      await apiPost(
        orgPath(orgId, `/credentials/${row.id}/review`),
        {
          decision,
          ...(reasons[row.id] ? { reason: reasons[row.id] } : {}),
          version: row.version,
        },
        resultSchema,
      );
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Credential review could not be saved.',
      );
    }
  };
  const reviewClearance = async (
    row: z.infer<typeof clearanceSchema>,
    decision: 'approve' | 'reject',
  ) => {
    const reason = reasons[row.id]?.trim();
    if (decision === 'reject' && (reason?.length ?? 0) < 8) {
      setError(
        'Enter an explanation of at least eight characters before rejecting a clearance.',
      );
      return;
    }
    try {
      await apiPost(
        `/safety/organizations/${orgId}/clearances/${row.id}/review`,
        { decision, ...(reason ? { reason } : {}), version: row.version },
        resultSchema,
      );
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Clearance review could not be saved.',
      );
    }
  };
  return (
    <main>
      <h1>Safety review queue</h1>
      <LoadState loading={loading} error={error} />
      {!loading && (
        <>
          <section>
            <h2>Credentials</h2>
            <Table>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Credential</th>
                  <th scope="col">Number</th>
                  <th scope="col">Expiry</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">Review</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      {row.firstName} {row.lastName}
                    </th>
                    <td>{row.credentialName}</td>
                    <td>{row.identifierHint ?? 'Not provided'}</td>
                    <td>{row.expiresOn ?? 'Calculated on approval'}</td>
                    <td>
                      {row.fileId ? (
                        <Button
                          type="button"
                          secondary
                          onClick={() =>
                            void downloadRestrictedEvidence(
                              orgId,
                              row.fileId ?? '',
                            ).catch((cause: unknown) => {
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : 'Restricted evidence could not be opened.',
                              );
                            })
                          }
                        >
                          Download restricted evidence
                        </Button>
                      ) : (
                        'No document'
                      )}
                    </td>
                    <td>
                      <Field label="Rejection reason">
                        <Input
                          value={reasons[row.id] ?? ''}
                          onChange={(event) => {
                            setReasons({
                              ...reasons,
                              [row.id]: event.target.value,
                            });
                          }}
                        />
                      </Field>
                      <Button
                        type="button"
                        onClick={() => void reviewCredential(row, 'approve')}
                      >
                        Approve
                      </Button>{' '}
                      <Button
                        type="button"
                        secondary
                        onClick={() => void reviewCredential(row, 'reject')}
                      >
                        Reject
                      </Button>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={6}>No credentials need review.</td>
                  </tr>
                )}
              </tbody>
            </Table>
          </section>
          <section>
            <h2>Return-to-play clearances</h2>
            <Table>
              <thead>
                <tr>
                  <th scope="col">Athlete</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Cleared on</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">Review</th>
                </tr>
              </thead>
              <tbody>
                {clearances.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      {row.firstName} {row.lastName}
                    </th>
                    <td>{row.providerName}</td>
                    <td>{row.clearedOn}</td>
                    <td>
                      <Button
                        type="button"
                        secondary
                        onClick={() =>
                          void downloadRestrictedEvidence(
                            orgId,
                            row.clearanceFileId,
                          ).catch((cause: unknown) => {
                            setError(
                              cause instanceof Error
                                ? cause.message
                                : 'Restricted evidence could not be opened.',
                            );
                          })
                        }
                      >
                        Download restricted evidence
                      </Button>
                    </td>
                    <td>
                      <Field label="Rejection reason">
                        <Input
                          value={reasons[row.id] ?? ''}
                          onChange={(event) => {
                            setReasons({
                              ...reasons,
                              [row.id]: event.target.value,
                            });
                          }}
                        />
                      </Field>
                      <Button
                        type="button"
                        onClick={() => void reviewClearance(row, 'approve')}
                      >
                        Clear athlete
                      </Button>{' '}
                      <Button
                        type="button"
                        secondary
                        onClick={() => void reviewClearance(row, 'reject')}
                      >
                        Reject
                      </Button>
                    </td>
                  </tr>
                ))}
                {!clearances.length && (
                  <tr>
                    <td colSpan={5}>
                      No return-to-play clearances need review.
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </section>
        </>
      )}
    </main>
  );
}

export function SafetyInjuries(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const [personId, setPersonId] = useState('');
  const [injuries, setInjuries] = useState<z.infer<typeof injurySchema>[]>([]);
  const [description, setDescription] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [suspectedConcussion, setSuspectedConcussion] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    if (!idSchema.safeParse(personId).success) {
      setError('Enter a valid athlete ID.');
      return;
    }
    try {
      setInjuries(
        await apiGet(
          `/safety/organizations/${orgId}/people/${personId}/injuries`,
          z.array(injurySchema),
        ),
      );
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Injury history could not be loaded.',
      );
    }
  };
  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !idSchema.safeParse(personId).success ||
      description.trim().length < 4 ||
      !occurredAt
    ) {
      setError('Add an athlete, date and injury description.');
      return;
    }
    try {
      await apiPost(
        `/safety/organizations/${orgId}/injuries`,
        {
          personId,
          occurredAt: new Date(occurredAt).toISOString(),
          suspectedConcussion,
          description,
        },
        resultSchema,
      );
      setDescription('');
      setError('');
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Injury report could not be submitted.',
      );
    }
  };
  return (
    <main>
      <h1>Injury and concussion reports</h1>
      <ErrorMessage message={error} />
      <Card>
        <h2>Report an injury</h2>
        <form onSubmit={(event) => void submit(event)}>
          <Field label="Athlete person ID">
            <Input
              value={personId}
              onChange={(event) => {
                setPersonId(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Occurred at">
            <Input
              type="datetime-local"
              value={occurredAt}
              onChange={(event) => {
                setOccurredAt(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Suspected concussion">
            <Input
              type="checkbox"
              checked={suspectedConcussion}
              onChange={(event) => {
                setSuspectedConcussion(event.target.checked);
              }}
            />
          </Field>
          {suspectedConcussion && (
            <p role="status">
              This report will place the athlete in injured status on every
              active team roster.
            </p>
          )}
          <Button type="submit">Submit injury report</Button>
        </form>
      </Card>
      <Card>
        <h2>Injury history</h2>
        <Field label="Athlete person ID">
          <Input
            value={personId}
            onChange={(event) => {
              setPersonId(event.target.value);
            }}
          />
        </Field>
        <Button type="button" secondary onClick={() => void load()}>
          Load history
        </Button>
        <Table>
          <thead>
            <tr>
              <th scope="col">Occurred</th>
              <th scope="col">Injury</th>
              <th scope="col">Status</th>
              <th scope="col">Description</th>
            </tr>
          </thead>
          <tbody>
            {injuries.map((row) => (
              <tr key={row.id}>
                <th scope="row">{new Date(row.occurredAt).toLocaleString()}</th>
                <td>
                  {row.suspectedConcussion
                    ? 'Suspected concussion'
                    : (row.injuryType ?? row.bodyPart ?? 'Injury')}
                </td>
                <td>
                  <Badge tone={row.status === 'cleared' ? 'ok' : 'warn'}>
                    {row.status.replaceAll('_', ' ')}
                  </Badge>
                </td>
                <td>{row.description}</td>
              </tr>
            ))}
            {!injuries.length && (
              <tr>
                <td colSpan={4}>No injury history loaded.</td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>
    </main>
  );
}

export function SafetyRequirements(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const [types, setTypes] = useState<z.infer<typeof typeSchema>[]>([]);
  const [requirements, setRequirements] = useState<
    z.infer<typeof requirementSchema>[]
  >([]);
  const [role, setRole] = useState('head_coach');
  const [credentialTypeId, setCredentialTypeId] = useState('');
  const [minimumAge, setMinimumAge] = useState('18');
  const [typeDrafts, setTypeDrafts] = useState<
    Record<string, CredentialTypeDraft>
  >({});
  const [requirementDrafts, setRequirementDrafts] = useState<
    Record<string, { minimumAge: string; active: boolean }>
  >({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const refresh = useCallback(async () => {
    const [typeRows, requirementRows] = await Promise.all([
      apiGet(orgPath(orgId, '/credential-types'), z.array(typeSchema)),
      apiGet(orgPath(orgId, '/requirements'), z.array(requirementSchema)),
    ]);
    setTypes(typeRows);
    setRequirements(requirementRows);
    setTypeDrafts(
      Object.fromEntries(
        typeRows.map((type) => [type.id, credentialTypeDraft(type)]),
      ),
    );
    setRequirementDrafts(
      Object.fromEntries(
        requirementRows.map((row) => [
          row.id,
          { minimumAge: String(row.minimumAge), active: row.active },
        ]),
      ),
    );
    if (!credentialTypeId && typeRows[0]) setCredentialTypeId(typeRows[0].id);
  }, [orgId, credentialTypeId]);
  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Requirements could not be loaded.',
      );
    });
  }, [refresh]);
  const addRequirement = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await apiPost(
        orgPath(orgId, '/requirements'),
        {
          role,
          credentialTypeId,
          scopeType: 'org',
          scopeId: null,
          minimumAge: Number(minimumAge),
          active: true,
        },
        resultSchema,
      );
      setSaved(true);
      setError('');
      await refresh();
    } catch (cause) {
      setSaved(false);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Requirement could not be saved.',
      );
    }
  };
  const saveCredentialType = async (type: CredentialType) => {
    const draft = typeDrafts[type.id];
    if (!draft) return;
    const reminderDays = draft.renewalReminderDays
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value));
    const validity =
      draft.validityMode === 'months'
        ? { months: Number(draft.months) }
        : draft.validityMode === 'expires_on_month_day'
          ? { expires_on_month_day: draft.monthDay }
          : { never: true as const };
    try {
      await apiPatch(
        orgPath(orgId, `/credential-types/${type.id}`),
        {
          name: draft.name,
          description: draft.description.trim() || null,
          validity,
          blocksActivation: draft.blocksActivation,
          renewalReminderDays: reminderDays,
          active: draft.active,
          version: type.version,
        },
        resultSchema,
      );
      setError('');
      setSaved(true);
      await refresh();
    } catch (cause) {
      setSaved(false);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Credential type could not be saved.',
      );
    }
  };
  const saveRequirement = async (row: z.infer<typeof requirementSchema>) => {
    const draft = requirementDrafts[row.id];
    if (!draft || !Number.isInteger(Number(draft.minimumAge))) {
      setError('Enter a whole number for the minimum age.');
      return;
    }
    try {
      await apiPatch(
        orgPath(orgId, `/requirements/${row.id}`),
        {
          id: row.id,
          version: row.version,
          role: row.role,
          credentialTypeId: row.credentialTypeId,
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          minimumAge: Number(draft.minimumAge),
          active: draft.active,
        },
        resultSchema,
      );
      setError('');
      setSaved(true);
      await refresh();
    } catch (cause) {
      setSaved(false);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Requirement could not be saved.',
      );
    }
  };
  return (
    <main>
      <h1>Credential types and requirements</h1>
      <Card>
        <h2>Credential library</h2>
        <Table>
          <thead>
            <tr>
              <th scope="col">Credential</th>
              <th scope="col">Verification</th>
              <th scope="col">Name</th>
              <th scope="col">Validity</th>
              <th scope="col">Blocks activation</th>
              <th scope="col">Reminder days</th>
              <th scope="col">Active</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {types.map((type) => (
              <tr key={type.id}>
                <td>
                  <strong>{type.key.replaceAll('_', ' ')}</strong>
                </td>
                <td>{type.verification.replaceAll('_', ' ')} (read-only)</td>
                <td>
                  <Input
                    value={typeDrafts[type.id]?.name ?? type.name}
                    onChange={(event) => {
                      setTypeDrafts({
                        ...typeDrafts,
                        [type.id]: {
                          ...credentialTypeDraft(type),
                          ...typeDrafts[type.id],
                          name: event.target.value,
                        },
                      });
                    }}
                    aria-label={`Credential name for ${type.name}`}
                  />
                  <Input
                    value={
                      typeDrafts[type.id]?.description ?? type.description ?? ''
                    }
                    onChange={(event) => {
                      setTypeDrafts({
                        ...typeDrafts,
                        [type.id]: {
                          ...credentialTypeDraft(type),
                          ...typeDrafts[type.id],
                          description: event.target.value,
                        },
                      });
                    }}
                    aria-label={`Description for ${type.name}`}
                  />
                </td>
                <td>
                  <Select
                    value={typeDrafts[type.id]?.validityMode ?? 'months'}
                    onChange={(event) => {
                      setTypeDrafts({
                        ...typeDrafts,
                        [type.id]: {
                          ...credentialTypeDraft(type),
                          ...typeDrafts[type.id],
                          validityMode: event.target
                            .value as CredentialTypeDraft['validityMode'],
                        },
                      });
                    }}
                    aria-label={`Validity type for ${type.name}`}
                    options={['months', 'expires_on_month_day', 'never']}
                  />
                  {typeDrafts[type.id]?.validityMode === 'months' && (
                    <Input
                      type="number"
                      min={1}
                      max={600}
                      value={typeDrafts[type.id]?.months ?? '12'}
                      onChange={(event) => {
                        setTypeDrafts({
                          ...typeDrafts,
                          [type.id]: {
                            ...credentialTypeDraft(type),
                            ...typeDrafts[type.id],
                            months: event.target.value,
                          },
                        });
                      }}
                      aria-label={`Validity months for ${type.name}`}
                    />
                  )}
                  {typeDrafts[type.id]?.validityMode ===
                    'expires_on_month_day' && (
                    <Input
                      value={typeDrafts[type.id]?.monthDay ?? '01-01'}
                      onChange={(event) => {
                        setTypeDrafts({
                          ...typeDrafts,
                          [type.id]: {
                            ...credentialTypeDraft(type),
                            ...typeDrafts[type.id],
                            monthDay: event.target.value,
                          },
                        });
                      }}
                      aria-label={`Validity month and day for ${type.name}`}
                      placeholder="MM-DD"
                    />
                  )}
                </td>
                <td>
                  <Input
                    type="checkbox"
                    checked={
                      typeDrafts[type.id]?.blocksActivation ??
                      type.blocks_activation
                    }
                    onChange={(event) => {
                      setTypeDrafts({
                        ...typeDrafts,
                        [type.id]: {
                          ...credentialTypeDraft(type),
                          ...typeDrafts[type.id],
                          blocksActivation: event.target.checked,
                        },
                      });
                    }}
                    aria-label={`Blocks activation for ${type.name}`}
                  />
                </td>
                <td>
                  <Input
                    value={
                      typeDrafts[type.id]?.renewalReminderDays ??
                      type.renewal_reminder_days.join(', ')
                    }
                    onChange={(event) => {
                      setTypeDrafts({
                        ...typeDrafts,
                        [type.id]: {
                          ...credentialTypeDraft(type),
                          ...typeDrafts[type.id],
                          renewalReminderDays: event.target.value,
                        },
                      });
                    }}
                    aria-label={`Reminder days for ${type.name}`}
                  />
                </td>
                <td>
                  <Input
                    type="checkbox"
                    checked={typeDrafts[type.id]?.active ?? type.active}
                    onChange={(event) => {
                      setTypeDrafts({
                        ...typeDrafts,
                        [type.id]: {
                          ...credentialTypeDraft(type),
                          ...typeDrafts[type.id],
                          active: event.target.checked,
                        },
                      });
                    }}
                    aria-label={`Active credential type ${type.name}`}
                  />
                  <Badge tone={type.active ? 'ok' : 'neutral'}>
                    {type.active ? 'Active' : 'Inactive'}
                  </Badge>
                </td>
                <td>
                  <Button
                    type="button"
                    onClick={() => void saveCredentialType(type)}
                  >
                    Save changes
                  </Button>
                </td>
              </tr>
            ))}
            {!types.length && (
              <tr>
                <td colSpan={8}>No credential types are configured.</td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>
      <Card>
        <h2>Requirements</h2>
        <Table>
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Credential</th>
              <th scope="col">Scope</th>
              <th scope="col">Minimum age</th>
              <th scope="col">State</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {requirements.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.role.replaceAll('_', ' ')}</th>
                <td>{row.credentialName}</td>
                <td>{row.scopeType}</td>
                <td>
                  <Input
                    type="number"
                    min={0}
                    max={120}
                    value={
                      requirementDrafts[row.id]?.minimumAge ??
                      String(row.minimumAge)
                    }
                    onChange={(event) => {
                      setRequirementDrafts({
                        ...requirementDrafts,
                        [row.id]: {
                          minimumAge: event.target.value,
                          active:
                            requirementDrafts[row.id]?.active ?? row.active,
                        },
                      });
                    }}
                    aria-label={`Minimum age for ${row.role.replaceAll('_', ' ')} ${row.credentialName}`}
                  />
                </td>
                <td>
                  <Input
                    type="checkbox"
                    checked={requirementDrafts[row.id]?.active ?? row.active}
                    onChange={(event) => {
                      setRequirementDrafts({
                        ...requirementDrafts,
                        [row.id]: {
                          minimumAge:
                            requirementDrafts[row.id]?.minimumAge ??
                            String(row.minimumAge),
                          active: event.target.checked,
                        },
                      });
                    }}
                    aria-label={`Active requirement for ${row.role.replaceAll('_', ' ')} ${row.credentialName}`}
                  />
                  {row.active ? 'Active' : 'Inactive'}
                </td>
                <td>
                  <Button
                    type="button"
                    onClick={() => void saveRequirement(row)}
                  >
                    Save changes
                  </Button>
                </td>
              </tr>
            ))}
            {!requirements.length && (
              <tr>
                <td colSpan={6}>
                  No custom requirements have been added. Platform defaults
                  still apply.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>
      <Card>
        <h2>Add an organization-wide requirement</h2>
        <form onSubmit={(event) => void addRequirement(event)}>
          <Field label="Role">
            <Select
              value={role}
              onChange={(event) => {
                setRole(event.target.value);
              }}
              options={[
                'head_coach',
                'assistant_coach',
                'team_manager',
                'trainer',
                'treasurer',
                'official',
                'volunteer',
                'evaluator',
              ]}
            />
          </Field>
          <Field label="Credential">
            <Select
              value={credentialTypeId}
              onChange={(event) => {
                setCredentialTypeId(event.target.value);
              }}
            >
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Minimum age">
            <Input
              type="number"
              min={18}
              max={120}
              value={minimumAge}
              onChange={(event) => {
                setMinimumAge(event.target.value);
              }}
              required
            />
          </Field>
          <Button type="submit" disabled={!credentialTypeId}>
            Add requirement
          </Button>
        </form>
        {saved && <p role="status">Requirement saved.</p>}
        <ErrorMessage message={error} />
      </Card>
    </main>
  );
}

export function SafetyIncidents(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const [rows, setRows] = useState<Incident[]>([]);
  const [details, setDetails] = useState<
    Record<string, z.infer<typeof emptySchema>>
  >({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setRows(
      await apiGet(
        `/safety/organizations/${orgId}/incidents`,
        z.array(incidentSchema),
      ),
    );
  }, [orgId]);
  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Incidents could not be loaded.',
      );
    });
  }, [refresh]);
  const open = async (incidentId: string) => {
    try {
      setDetails({
        ...details,
        [incidentId]: await apiGet(
          `/safety/organizations/${orgId}/incidents/${incidentId}`,
          emptySchema,
        ),
      });
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Incident could not be opened.',
      );
    }
  };
  const update = async (row: Incident, status: string) => {
    const resolution = reasons[row.id]?.trim();
    if (status === 'closed' && (resolution?.length ?? 0) < 8) {
      setError(
        'Enter a resolution of at least eight characters to close an incident.',
      );
      return;
    }
    try {
      await apiPatch(
        `/safety/organizations/${orgId}/incidents/${row.id}`,
        { status, version: row.version, ...(resolution ? { resolution } : {}) },
        resultSchema,
      );
      await refresh();
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Incident could not be updated.',
      );
    }
  };
  return (
    <main>
      <h1>Incident review</h1>
      <ErrorMessage message={error} />
      <DataTable
        rows={rows}
        columns={[
          {
            key: 'category',
            label: 'Category',
            render: (row) => (
              <>
                {row.category.replaceAll('_', ' ')}{' '}
                {row.restricted && (
                  <Badge tone="bad">Restricted SafeSport</Badge>
                )}
              </>
            ),
          },
          {
            key: 'occurredAt',
            label: 'Reported',
            render: (row) => new Date(row.occurredAt).toLocaleString(),
          },
          {
            key: 'status',
            label: 'Status',
            render: (row) => (
              <Badge tone={row.status === 'closed' ? 'ok' : 'pending'}>
                {row.status.replaceAll('_', ' ')}
              </Badge>
            ),
          },
          {
            key: 'actions',
            label: 'Review',
            render: (row) => (
              <Button type="button" secondary onClick={() => void open(row.id)}>
                Read audited report
              </Button>
            ),
          },
        ]}
        empty="No incidents are visible to your role."
      />
      {rows.map((row) => {
        const detail = details[row.id];
        if (!detail) return null;
        const narrative = detail.narrative;
        const resolution = detail.resolution;
        return (
          <Card key={row.id}>
            <h2>{row.category.replaceAll('_', ' ')}</h2>
            <p>{typeof narrative === 'string' ? narrative : ''}</p>
            <p>{typeof resolution === 'string' ? resolution : ''}</p>
            <Field label="Resolution">
              <Textarea
                value={reasons[row.id] ?? ''}
                onChange={(event) => {
                  setReasons({ ...reasons, [row.id]: event.target.value });
                }}
              />
            </Field>
            <Button
              type="button"
              onClick={() => void update(row, 'under_review')}
            >
              Mark under review
            </Button>{' '}
            <Button
              type="button"
              secondary
              onClick={() => void update(row, 'closed')}
            >
              Close incident
            </Button>
          </Card>
        );
      })}
    </main>
  );
}

export function SafetyBackgroundChecks(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const [checks, setChecks] = useState<z.infer<typeof checkSchema>[]>([]);
  const [disputes, setDisputes] = useState<z.infer<typeof disputeSchema>[]>([]);
  const [error, setError] = useState('');
  const [reason, setReason] = useState<Record<string, string>>({});
  const [details, setDetails] = useState<Record<string, string>>({});
  const [manualStatus, setManualStatus] = useState<
    Record<string, 'clear' | 'consider' | 'suspended' | 'canceled' | 'expired'>
  >({});
  const refresh = useCallback(async () => {
    const [checkRows, disputeRows] = await Promise.all([
      apiGet(orgPath(orgId, '/background-checks'), z.array(checkSchema)),
      apiGet(
        orgPath(orgId, '/background-check-disputes'),
        z.array(disputeSchema),
      ),
    ]);
    setChecks(checkRows);
    setDisputes(disputeRows);
  }, [orgId]);
  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Background checks could not be loaded.',
      );
    });
  }, [refresh]);
  const recordResult = async (row: z.infer<typeof checkSchema>) => {
    const data = details[row.id] ?? '';
    const status = manualStatus[row.id] ?? 'consider';
    const resultSummary =
      status === 'clear'
        ? 'clear'
        : status === 'consider'
          ? 'consider'
          : 'adverse_action';
    try {
      await apiPost(
        orgPath(orgId, `/background-checks/${row.id}/manual-result`),
        { status, resultSummary, details: data, version: row.version },
        resultSchema,
      );
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The result could not be recorded.',
      );
    }
  };
  const adjudicate = async (
    row: z.infer<typeof checkSchema>,
    adjudication: 'eligible' | 'ineligible',
  ) => {
    if ((reason[row.id]?.trim().length ?? 0) < 8) {
      setError('Enter an adjudication reason of at least eight characters.');
      return;
    }
    try {
      await apiPost(
        orgPath(orgId, `/background-checks/${row.id}/adjudication`),
        { adjudication, reason: reason[row.id], version: row.version },
        resultSchema,
      );
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Adjudication could not be saved.',
      );
    }
  };
  const sendPreAdverse = async (row: z.infer<typeof checkSchema>) => {
    try {
      await apiPost(
        orgPath(orgId, `/background-checks/${row.id}/pre-adverse-notice`),
        {},
        resultSchema,
      );
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Pre-adverse notice could not be sent.',
      );
    }
  };
  const sendAdverse = async (row: z.infer<typeof checkSchema>) => {
    try {
      await apiPost(
        orgPath(orgId, `/background-checks/${row.id}/adverse-notice`),
        {},
        resultSchema,
      );
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Final adverse notice could not be sent.',
      );
    }
  };
  const resolve = async (row: z.infer<typeof disputeSchema>) => {
    if ((reason[row.id]?.trim().length ?? 0) < 10) {
      setError('Enter a dispute resolution of at least ten characters.');
      return;
    }
    try {
      await apiPatch(
        orgPath(orgId, `/background-check-disputes/${row.id}`),
        { resolution: reason[row.id], version: row.version },
        resultSchema,
      );
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Dispute could not be resolved.',
      );
    }
  };
  return (
    <main>
      <h1>Background checks</h1>
      <ErrorMessage message={error} />
      <section>
        <h2>Orders</h2>
        <Table>
          <thead>
            <tr>
              <th scope="col">Candidate</th>
              <th scope="col">Provider</th>
              <th scope="col">Result</th>
              <th scope="col">Manual result</th>
              <th scope="col">FCRA action</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  {row.firstName} {row.lastName}
                </th>
                <td>
                  {row.provider} · {row.package}
                </td>
                <td>
                  {row.resultSummary ?? row.status} · {row.adjudication}
                </td>
                <td>
                  {row.provider === 'manual' &&
                    row.adjudication === 'pending' && (
                      <>
                        <Field label="Result">
                          <Select
                            value={manualStatus[row.id] ?? 'consider'}
                            onChange={(event) => {
                              setManualStatus({
                                ...manualStatus,
                                [row.id]: event.target.value as
                                  | 'clear'
                                  | 'consider'
                                  | 'suspended'
                                  | 'canceled'
                                  | 'expired',
                              });
                            }}
                            options={[
                              'clear',
                              'consider',
                              'suspended',
                              'canceled',
                              'expired',
                            ]}
                          />
                        </Field>
                        <Field label="Restricted report details">
                          <Textarea
                            value={details[row.id] ?? ''}
                            onChange={(event) => {
                              setDetails({
                                ...details,
                                [row.id]: event.target.value,
                              });
                            }}
                          />
                        </Field>
                        <Button
                          type="button"
                          onClick={() => void recordResult(row)}
                        >
                          Record result
                        </Button>
                      </>
                    )}
                </td>
                <td>
                  {row.resultSummary === 'consider' &&
                    row.adjudication === 'pending' && (
                      <>
                        <Button
                          type="button"
                          secondary
                          onClick={() => void sendPreAdverse(row)}
                        >
                          Send pre-adverse notice
                        </Button>
                        <Field label="Adjudication reason">
                          <Textarea
                            value={reason[row.id] ?? ''}
                            onChange={(event) => {
                              setReason({
                                ...reason,
                                [row.id]: event.target.value,
                              });
                            }}
                          />
                        </Field>
                        <Button
                          type="button"
                          onClick={() => void adjudicate(row, 'eligible')}
                        >
                          Mark eligible
                        </Button>{' '}
                        <Button
                          type="button"
                          secondary
                          onClick={() => void adjudicate(row, 'ineligible')}
                        >
                          Mark ineligible after FCRA period
                        </Button>
                      </>
                    )}
                  {row.adjudication === 'ineligible' &&
                    !row.adverseNoticeAt && (
                      <Button
                        type="button"
                        onClick={() => void sendAdverse(row)}
                      >
                        Send final adverse notice
                      </Button>
                    )}
                </td>
              </tr>
            ))}
            {!checks.length && (
              <tr>
                <td colSpan={5}>No background checks have been started.</td>
              </tr>
            )}
          </tbody>
        </Table>
      </section>
      <section>
        <h2>Candidate disputes</h2>
        <Table>
          <thead>
            <tr>
              <th scope="col">Candidate</th>
              <th scope="col">Statement</th>
              <th scope="col">Submitted</th>
              <th scope="col">Resolution</th>
            </tr>
          </thead>
          <tbody>
            {disputes.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  {row.firstName} {row.lastName}
                </th>
                <td>{row.statement}</td>
                <td>{new Date(row.submittedAt).toLocaleString()}</td>
                <td>
                  <Field label="Resolution">
                    <Textarea
                      value={reason[row.id] ?? ''}
                      onChange={(event) => {
                        setReason({ ...reason, [row.id]: event.target.value });
                      }}
                    />
                  </Field>
                  <Button type="button" onClick={() => void resolve(row)}>
                    Resolve dispute
                  </Button>
                </td>
              </tr>
            ))}
            {!disputes.length && (
              <tr>
                <td colSpan={4}>No open disputes.</td>
              </tr>
            )}
          </tbody>
        </Table>
      </section>
    </main>
  );
}

const settingsSchema = z.object({
  settings: z
    .object({
      providerMode: z.string(),
      volunteerPaysFee: z.boolean(),
      package: z.string(),
      disclosureVersion: z.string().nullable(),
      disclosureText: z.string().nullable(),
      authorizationVersion: z.string().nullable(),
      authorizationText: z.string().nullable(),
      preAdverseNoticeText: z.string().nullable(),
      rightsSummaryText: z.string().nullable(),
      adverseNoticeText: z.string().nullable(),
      fcraHolidays: z.array(z.string()),
      version: z.number(),
    })
    .nullable(),
  options: z.object({ manual: z.boolean(), checkr: z.boolean() }),
});

export function SafetySettings(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const [settings, setSettings] = useState<z.infer<
    typeof settingsSchema
  > | null>(null);
  const [providerMode, setProviderMode] = useState('manual');
  const [packageName, setPackageName] = useState('basic');
  const [disclosureVersion, setDisclosureVersion] = useState('');
  const [disclosureText, setDisclosureText] = useState('');
  const [authorizationVersion, setAuthorizationVersion] = useState('');
  const [authorizationText, setAuthorizationText] = useState('');
  const [preAdverseNoticeText, setPreAdverseNoticeText] = useState('');
  const [rightsSummaryText, setRightsSummaryText] = useState('');
  const [adverseNoticeText, setAdverseNoticeText] = useState('');
  const [holidayText, setHolidayText] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const refresh = useCallback(async () => {
    const value = await apiGet(
      `/compliance/organizations/${orgId}/background-check-settings`,
      settingsSchema,
    );
    setSettings(value);
    const current = value.settings;
    if (current) {
      setProviderMode(current.providerMode);
      setPackageName(current.package);
      setDisclosureVersion(current.disclosureVersion ?? '');
      setDisclosureText(current.disclosureText ?? '');
      setAuthorizationVersion(current.authorizationVersion ?? '');
      setAuthorizationText(current.authorizationText ?? '');
      setPreAdverseNoticeText(current.preAdverseNoticeText ?? '');
      setRightsSummaryText(current.rightsSummaryText ?? '');
      setAdverseNoticeText(current.adverseNoticeText ?? '');
      setHolidayText(
        current.fcraHolidays.map((date) => date.slice(0, 10)).join(', '),
      );
    }
  }, [orgId]);
  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Background-check settings could not be loaded.',
      );
    });
  }, [refresh]);
  const save = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await apiPatch(
        `/compliance/organizations/${orgId}/background-check-settings`,
        {
          providerMode,
          volunteerPaysFee: false,
          package: packageName,
          disclosureVersion,
          disclosureText,
          authorizationVersion,
          authorizationText,
          preAdverseNoticeText,
          rightsSummaryText,
          adverseNoticeText,
          fcraHolidays: holidayText
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          version: settings?.settings?.version ?? 1,
        },
        emptySchema,
      );
      setSaved(true);
      setError('');
      await refresh();
    } catch (cause) {
      setSaved(false);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Background-check settings could not be saved.',
      );
    }
  };
  return (
    <main>
      <h1>Background-check settings</h1>
      <Card>
        <p>
          Review and version each notice before offering checks to candidates.
          These templates are stored with each authorized order.
        </p>
        <form onSubmit={(event) => void save(event)}>
          <Field label="Provider">
            <Select
              value={providerMode}
              onChange={(event) => {
                setProviderMode(event.target.value);
              }}
            >
              <option value="manual">Manual review</option>
              {settings?.options.checkr && (
                <option value="checkr">
                  Checkr staging or configured provider
                </option>
              )}
            </Select>
          </Field>
          <Field label="Package">
            <Input
              value={packageName}
              onChange={(event) => {
                setPackageName(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Disclosure version">
            <Input
              value={disclosureVersion}
              onChange={(event) => {
                setDisclosureVersion(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Standalone disclosure">
            <Textarea
              value={disclosureText}
              onChange={(event) => {
                setDisclosureText(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Authorization version">
            <Input
              value={authorizationVersion}
              onChange={(event) => {
                setAuthorizationVersion(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Authorization text">
            <Textarea
              value={authorizationText}
              onChange={(event) => {
                setAuthorizationText(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Pre-adverse notice">
            <Textarea
              value={preAdverseNoticeText}
              onChange={(event) => {
                setPreAdverseNoticeText(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Rights summary">
            <Textarea
              value={rightsSummaryText}
              onChange={(event) => {
                setRightsSummaryText(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Final adverse notice">
            <Textarea
              value={adverseNoticeText}
              onChange={(event) => {
                setAdverseNoticeText(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="FCRA holidays (YYYY-MM-DD, comma separated)">
            <Input
              value={holidayText}
              onChange={(event) => {
                setHolidayText(event.target.value);
              }}
            />
          </Field>
          <Button type="submit">Save settings</Button>
        </form>
        {saved && <p role="status">Background-check settings saved.</p>}
        <ErrorMessage message={error} />
      </Card>
    </main>
  );
}

export function SafetyCards(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const [personId, setPersonId] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [programId, setProgramId] = useState('');
  const [seasonId, setSeasonId] = useState('');
  const [cardKind, setCardKind] = useState('player');
  const [cards, setCards] = useState<CardRow[]>([]);
  const [error, setError] = useState('');
  const loadCards = async () => {
    if (!idSchema.safeParse(personId).success) {
      setError('Enter the person ID to list issued cards.');
      return;
    }
    try {
      setCards(
        await apiGet(
          orgPath(orgId, `/people/${personId}/cards`),
          z.array(cardSchema),
        ),
      );
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Cards could not be loaded.',
      );
    }
  };
  const create = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const program = programId.trim();
    const season = seasonId.trim();
    if (
      !idSchema.safeParse(personId).success ||
      !idSchema.safeParse(program || season).success ||
      Boolean(program) === Boolean(season)
    ) {
      setError(
        'Enter a valid person ID and exactly one valid program or season ID.',
      );
      return;
    }
    try {
      await apiPost(
        orgPath(orgId, '/cards'),
        {
          personId,
          cardKind,
          programId: program || null,
          seasonId: season || null,
          cardNumber,
          validUntil,
        },
        resultSchema,
      );
      setError('');
      await loadCards();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Card could not be issued.',
      );
    }
  };
  const revoke = async (row: CardRow) => {
    try {
      await apiPatch(
        orgPath(orgId, `/cards/${row.id}`),
        { status: 'revoked', version: row.version },
        resultSchema,
      );
      await loadCards();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Card could not be revoked.',
      );
    }
  };
  return (
    <main>
      <h1>Player and staff cards</h1>
      <Card>
        <h2>Issue a card</h2>
        <form onSubmit={(event) => void create(event)}>
          <Field label="Person ID">
            <Input
              value={personId}
              onChange={(event) => {
                setPersonId(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Card kind">
            <Select
              value={cardKind}
              onChange={(event) => {
                setCardKind(event.target.value);
              }}
              options={['player', 'staff']}
            />
          </Field>
          <Field label="Program ID">
            <Input
              value={programId}
              onChange={(event) => {
                setProgramId(event.target.value);
              }}
            />
          </Field>
          <Field label="Season ID">
            <Input
              value={seasonId}
              onChange={(event) => {
                setSeasonId(event.target.value);
              }}
            />
          </Field>
          <Field label="Card number">
            <Input
              value={cardNumber}
              onChange={(event) => {
                setCardNumber(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Valid until">
            <Input
              type="date"
              value={validUntil}
              onChange={(event) => {
                setValidUntil(event.target.value);
              }}
              required
            />
          </Field>
          <Button type="submit">Issue card</Button>
        </form>
      </Card>
      <Card>
        <h2>Issued cards</h2>
        <Field label="Person ID">
          <Input
            value={personId}
            onChange={(event) => {
              setPersonId(event.target.value);
            }}
          />
        </Field>
        <Button type="button" secondary onClick={() => void loadCards()}>
          Load cards
        </Button>
        <ErrorMessage message={error} />
        <div>
          {cards.map((row) => (
            <Card key={row.id}>
              <h3>
                {row.cardKind} card {row.cardNumber}
              </h3>
              <p>
                Valid through {row.validUntil} · {row.status}
              </p>
              <QRCode
                value={row.verificationUrl}
                label={`Verification QR for card ${row.cardNumber}`}
              />
              <a href={row.verificationUrl}>Open verification page</a>
              {row.status === 'active' && (
                <Button
                  type="button"
                  secondary
                  onClick={() => void revoke(row)}
                >
                  Revoke card
                </Button>
              )}
            </Card>
          ))}
        </div>
      </Card>
      {cards.length > 0 && <PrintSheet cards={cards} />}
    </main>
  );
}

function PrintSheet({ cards }: { cards: CardRow[] }): React.JSX.Element {
  return (
    <section className="ui-print-layout">
      <h2>Printable cards</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 'var(--space-12)',
        }}
      >
        {cards
          .filter((row) => row.status === 'active')
          .map((row) => (
            <article
              key={row.id}
              style={{
                breakInside: 'avoid',
                border: '1px solid var(--line)',
                padding: 'var(--space-12)',
              }}
            >
              <h3>Athlentry {row.cardKind} card</h3>
              <p>
                {row.cardNumber} · Valid through {row.validUntil}
              </p>
              <QRCode
                value={row.verificationUrl}
                label={`Verification QR for card ${row.cardNumber}`}
              />
            </article>
          ))}
      </div>
      <Button
        type="button"
        onClick={() => {
          window.print();
        }}
      >
        Print cards
      </Button>
    </section>
  );
}
