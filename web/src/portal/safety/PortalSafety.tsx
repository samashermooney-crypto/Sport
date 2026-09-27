import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import {
  Badge,
  Button,
  Card,
  Field,
  FileUpload,
  Input,
  QRCode,
  Select,
  Table,
  Textarea,
} from '../../ui';

const idSchema = z.uuid();
const typeSchema = z.object({
  id: z.string(),
  name: z.string(),
  verification: z.string(),
  active: z.boolean(),
});
const credentialSchema = z.object({
  id: z.string(),
  credentialTypeId: z.string(),
  credentialName: z.string(),
  status: z.string(),
  identifierHint: z.string().nullable(),
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  fileId: z.string().nullable(),
  version: z.number(),
});
const injurySchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  bodyPart: z.string().nullable(),
  injuryType: z.string().nullable(),
  suspectedConcussion: z.boolean(),
  description: z.string(),
  status: z.string(),
  version: z.number(),
});
const cardSchema = z.object({
  id: z.string(),
  cardKind: z.string(),
  cardNumber: z.string(),
  status: z.string(),
  validUntil: z.string(),
  token: z.string(),
  verificationUrl: z.string(),
});
const checkSchema = z.object({
  id: z.string(),
  personId: z.string(),
  status: z.string(),
  resultSummary: z.string().nullable(),
  adjudication: z.string(),
  preAdverseNoticeAt: z.string().nullable(),
  adverseNoticeAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
});
const settingsSchema = z.object({
  settings: z
    .object({
      providerMode: z.string(),
      package: z.string(),
      disclosureVersion: z.string().nullable(),
      disclosureText: z.string().nullable(),
      authorizationVersion: z.string().nullable(),
      authorizationText: z.string().nullable(),
      rightsSummaryText: z.string().nullable(),
    })
    .nullable(),
  options: z.object({ manual: z.boolean(), checkr: z.boolean() }),
});
const checkDetailsSchema = z.object({
  id: z.string(),
  status: z.string(),
  resultSummary: z.string().nullable(),
  adjudication: z.string(),
  disclosureText: z.string().nullable(),
  disclosureVersion: z.string().nullable(),
  authorizationText: z.string().nullable(),
  authorizationVersion: z.string().nullable(),
  rightsSummaryText: z.string(),
  preAdverseNoticeAt: z.string().nullable(),
  adverseNoticeAt: z.string().nullable(),
  details: z.string().nullable(),
});
const disputeSchema = z.object({
  id: z.string(),
  status: z.string(),
  submittedAt: z.string(),
  resolvedAt: z.string().nullable(),
  statement: z.string(),
  resolution: z.string().nullable(),
});
const publicCardSchema = z.object({
  cardId: z.string(),
  cardNumber: z.string(),
  cardKind: z.string(),
  personName: z.string(),
  teamName: z.string().nullable(),
  validUntil: z.string(),
  photoAvailable: z.boolean(),
  photoUrl: z.string().optional(),
});
const uploadSchema = z.object({ fileId: z.uuid(), uploadUrl: z.string() });
const resultSchema = z.looseObject({ id: z.string() });

function fileType(file: File): string {
  if (file.type) return file.type;
  return file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : '';
}

async function uploadRestrictedFile(
  orgId: string,
  file: File,
  ownerType: string,
  ownerId: string,
): Promise<string> {
  const mime = fileType(file);
  const request = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set('X-Athlentry-Request', '1');
    headers.set('X-Athlentry-Org', orgId);
    const response = await fetch(url, {
      ...init,
      credentials: 'include',
      headers,
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => null)) as {
        error?: { message?: string } | string;
        message?: string;
      } | null;
      throw new Error(
        (typeof value?.error === 'object' ? value.error.message : undefined) ??
          value?.message ??
          'Restricted document upload is unavailable.',
      );
    }
    return response;
  };
  const beginResponse = await request('/api/v1/files/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      purpose: 'document',
      mime,
      bytes: file.size,
      ownerType,
      ownerId,
      sensitivity: 'restricted',
    }),
  });
  const begin = uploadSchema.parse(await beginResponse.json());
  await request(begin.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mime },
    body: file,
  });
  await request(`/api/v1/files/uploads/${begin.fileId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return begin.fileId;
}

export function PortalPersonSafety(): React.JSX.Element {
  const { orgId = '', personId = '' } = useParams();
  const [types, setTypes] = useState<z.infer<typeof typeSchema>[]>([]);
  const [credentials, setCredentials] = useState<
    z.infer<typeof credentialSchema>[]
  >([]);
  const [injuries, setInjuries] = useState<z.infer<typeof injurySchema>[]>([]);
  const [cards, setCards] = useState<z.infer<typeof cardSchema>[]>([]);
  const [checks, setChecks] = useState<z.infer<typeof checkSchema>[]>([]);
  const [checkDetails, setCheckDetails] = useState<
    Record<string, z.infer<typeof checkDetailsSchema>>
  >({});
  const [disputes, setDisputes] = useState<
    Record<string, z.infer<typeof disputeSchema>[]>
  >({});
  const [settings, setSettings] = useState<z.infer<
    typeof settingsSchema
  > | null>(null);
  const [credentialTypeId, setCredentialTypeId] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [credentialFile, setCredentialFile] = useState<File | null>(null);
  const [editingCredential, setEditingCredential] = useState<string | null>(
    null,
  );
  const [credentialEditIdentifier, setCredentialEditIdentifier] = useState('');
  const [credentialEditIssuedOn, setCredentialEditIssuedOn] = useState('');
  const [credentialEditExpiresOn, setCredentialEditExpiresOn] = useState('');
  const [credentialEditFile, setCredentialEditFile] = useState<File | null>(
    null,
  );
  const [credentialRevokeReason, setCredentialRevokeReason] = useState('');
  const [injuryOccurredAt, setInjuryOccurredAt] = useState('');
  const [injuryDescription, setInjuryDescription] = useState('');
  const [concussion, setConcussion] = useState(false);
  const [clearanceFiles, setClearanceFiles] = useState<
    Record<string, File | null>
  >({});
  const [providerName, setProviderName] = useState('');
  const [clearedOn, setClearedOn] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [backgroundCase, setBackgroundCase] = useState('');
  const [disputeStatement, setDisputeStatement] = useState('');
  const [incidentCategory, setIncidentCategory] = useState('safesport_concern');
  const [incidentNarrative, setIncidentNarrative] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const validIds =
    idSchema.safeParse(orgId).success && idSchema.safeParse(personId).success;
  const refresh = useCallback(async () => {
    if (!validIds) return;
    const [
      typeRows,
      credentialRows,
      injuryRows,
      cardRows,
      checkRows,
      checkSettings,
    ] = await Promise.all([
      apiGet(
        `/compliance/organizations/${orgId}/credential-types`,
        z.array(typeSchema),
      ),
      apiGet(
        `/compliance/organizations/${orgId}/people/${personId}/credentials`,
        z.array(credentialSchema),
      ),
      apiGet(
        `/safety/organizations/${orgId}/people/${personId}/injuries`,
        z.array(injurySchema),
      ),
      apiGet(
        `/compliance/organizations/${orgId}/people/${personId}/cards`,
        z.array(cardSchema),
      ),
      apiGet(
        `/compliance/organizations/${orgId}/my-background-checks`,
        z.array(checkSchema),
      ),
      apiGet(
        `/compliance/organizations/${orgId}/background-check-settings`,
        settingsSchema,
      ),
    ]);
    setTypes(typeRows);
    setCredentials(credentialRows);
    setInjuries(injuryRows);
    setCards(cardRows);
    setChecks(checkRows);
    setSettings(checkSettings);
    if (!credentialTypeId && typeRows[0]) setCredentialTypeId(typeRows[0].id);
  }, [orgId, personId, credentialTypeId, validIds]);
  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Safety records could not be loaded.',
      );
    });
  }, [refresh]);

  const addCredential = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const fileId = credentialFile
        ? await uploadRestrictedFile(
            orgId,
            credentialFile,
            'person_credential',
            personId,
          )
        : undefined;
      await apiPost(
        `/compliance/organizations/${orgId}/credentials`,
        {
          personId,
          credentialTypeId,
          ...(identifier.trim() ? { identifier: identifier.trim() } : {}),
          issuedOn: issuedOn || null,
          expiresOn: expiresOn || null,
          ...(fileId ? { fileId } : {}),
        },
        resultSchema,
      );
      setCredentialFile(null);
      setIdentifier('');
      setMessage('Credential submitted for review.');
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Credential could not be submitted.',
      );
    }
  };
  const startCredentialEdit = (row: z.infer<typeof credentialSchema>) => {
    setEditingCredential(row.id);
    setCredentialEditIdentifier('');
    setCredentialEditIssuedOn(row.issuedOn?.slice(0, 10) ?? '');
    setCredentialEditExpiresOn(row.expiresOn?.slice(0, 10) ?? '');
    setCredentialEditFile(null);
  };
  const saveCredentialEdit = async (row: z.infer<typeof credentialSchema>) => {
    try {
      const fileId = credentialEditFile
        ? await uploadRestrictedFile(
            orgId,
            credentialEditFile,
            'person_credential',
            personId,
          )
        : row.fileId;
      await apiPatch(
        `/compliance/organizations/${orgId}/credentials/${row.id}`,
        {
          ...(credentialEditIdentifier.trim()
            ? { identifier: credentialEditIdentifier.trim() }
            : {}),
          issuedOn: credentialEditIssuedOn || null,
          expiresOn: credentialEditExpiresOn || null,
          fileId,
          version: row.version,
        },
        resultSchema,
      );
      setEditingCredential(null);
      setCredentialEditFile(null);
      setMessage('Credential corrections were submitted for review.');
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Credential correction could not be saved.',
      );
    }
  };
  const revokeCredential = async (row: z.infer<typeof credentialSchema>) => {
    if (credentialRevokeReason.trim().length < 8) {
      setError('Enter at least eight characters explaining the revocation.');
      return;
    }
    try {
      await apiPost(
        `/compliance/organizations/${orgId}/credentials/${row.id}/revoke`,
        { reason: credentialRevokeReason.trim(), version: row.version },
        resultSchema,
      );
      setCredentialRevokeReason('');
      setMessage(
        'Credential revoked. Staff eligibility will be checked again.',
      );
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Credential could not be revoked.',
      );
    }
  };
  const reportInjury = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await apiPost(
        `/safety/organizations/${orgId}/injuries`,
        {
          personId,
          occurredAt: new Date(injuryOccurredAt).toISOString(),
          suspectedConcussion: concussion,
          description: injuryDescription,
        },
        resultSchema,
      );
      setInjuryDescription('');
      setMessage('Injury report submitted. Guardians have been notified.');
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Injury report could not be submitted.',
      );
    }
  };
  const uploadClearance = async (row: z.infer<typeof injurySchema>) => {
    const file = clearanceFiles[row.id];
    if (!file || providerName.trim().length < 2 || !clearedOn) {
      setError('Choose the clearance document, provider and clearance date.');
      return;
    }
    try {
      const fileId = await uploadRestrictedFile(
        orgId,
        file,
        'return_to_play_clearance',
        row.id,
      );
      await apiPost(
        `/safety/organizations/${orgId}/injuries/${row.id}/clearances`,
        { fileId, providerName, clearedOn },
        resultSchema,
      );
      setMessage('Return-to-play clearance submitted for compliance review.');
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Clearance could not be submitted.',
      );
    }
  };
  const startBackgroundCheck = async (
    event: React.SubmitEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (!accepted) {
      setError('Confirm the disclosure and authorization before continuing.');
      return;
    }
    const current = settings?.settings;
    if (!current?.disclosureVersion || !current.authorizationVersion) {
      setError(
        'The organization has not configured background-check consent text.',
      );
      return;
    }
    try {
      const result = await apiPost(
        `/compliance/organizations/${orgId}/background-checks`,
        {
          personId,
          disclosureVersion: current.disclosureVersion,
          authorizationVersion: current.authorizationVersion,
          accepted: true,
        },
        resultSchema,
      );
      setBackgroundCase(result.id);
      setAccepted(false);
      setError('');
      setMessage('Background check authorized and started.');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Background check could not be started.',
      );
    }
  };
  const submitDispute = async (orderId: string) => {
    if (disputeStatement.trim().length < 10) {
      setError('Write at least ten characters explaining the report dispute.');
      return;
    }
    try {
      await apiPost(
        `/compliance/organizations/${orgId}/background-checks/${orderId}/disputes`,
        { statement: disputeStatement },
        resultSchema,
      );
      setDisputeStatement('');
      setMessage('Your dispute was sent to the compliance reviewer.');
      setError('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Dispute could not be submitted.',
      );
    }
  };
  const readCheck = async (orderId: string) => {
    try {
      const [details, disputeRows] = await Promise.all([
        apiGet(
          `/compliance/organizations/${orgId}/background-checks/${orderId}`,
          checkDetailsSchema,
        ),
        apiGet(
          `/compliance/organizations/${orgId}/background-checks/${orderId}/disputes`,
          z.array(disputeSchema),
        ),
      ]);
      setCheckDetails({ ...checkDetails, [orderId]: details });
      setDisputes({ ...disputes, [orderId]: disputeRows });
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Background-check details could not be opened.',
      );
    }
  };
  const reportConcern = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (incidentNarrative.trim().length < 10) {
      setError('Add at least ten characters to your report.');
      return;
    }
    try {
      await apiPost(
        `/safety/organizations/${orgId}/incidents`,
        {
          category: incidentCategory,
          occurredAt: new Date().toISOString(),
          peopleInvolved: [personId],
          narrative: incidentNarrative,
        },
        resultSchema,
      );
      setIncidentNarrative('');
      setMessage(
        'Your report was submitted to the designated organization officers.',
      );
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Report could not be submitted.',
      );
    }
  };
  if (!validIds)
    return (
      <main>
        <h1>Safety</h1>
        <p>
          Choose an organization and person from the portal before opening
          safety records.
        </p>
      </main>
    );
  const currentSettings = settings?.settings;
  return (
    <main>
      <h1>Safety and compliance</h1>
      <p>
        Keep credentials current and review safety actions for this athlete.
      </p>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <Card>
        <h2>Credentials</h2>
        <Field label="Reason for revoking a credential">
          <Input
            value={credentialRevokeReason}
            onChange={(event) => {
              setCredentialRevokeReason(event.target.value);
            }}
            minLength={8}
            maxLength={2000}
          />
        </Field>
        <Table>
          <thead>
            <tr>
              <th scope="col">Credential</th>
              <th scope="col">Status</th>
              <th scope="col">Number</th>
              <th scope="col">Expires</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {credentials.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.credentialName}</th>
                <td>
                  <Badge
                    tone={
                      row.status === 'verified'
                        ? 'ok'
                        : row.status === 'rejected' || row.status === 'expired'
                          ? 'bad'
                          : 'pending'
                    }
                  >
                    {row.status.replaceAll('_', ' ')}
                  </Badge>
                </td>
                <td>{row.identifierHint ?? '—'}</td>
                <td>{row.expiresOn ?? 'Pending review'}</td>
                <td>
                  {row.status === 'pending_review' && (
                    <>
                      {editingCredential === row.id ? (
                        <>
                          <Field
                            label={`Credential number for ${row.credentialName}`}
                          >
                            <Input
                              value={credentialEditIdentifier}
                              onChange={(event) => {
                                setCredentialEditIdentifier(event.target.value);
                              }}
                              maxLength={300}
                              autoComplete="off"
                            />
                          </Field>
                          <Field label="Issued on">
                            <Input
                              type="date"
                              value={credentialEditIssuedOn}
                              onChange={(event) => {
                                setCredentialEditIssuedOn(event.target.value);
                              }}
                            />
                          </Field>
                          <Field label="Expires on">
                            <Input
                              type="date"
                              value={credentialEditExpiresOn}
                              onChange={(event) => {
                                setCredentialEditExpiresOn(event.target.value);
                              }}
                            />
                          </Field>
                          <FileUpload
                            label="Replace restricted credential document (PDF)"
                            accept="application/pdf"
                            onFiles={(files) => {
                              setCredentialEditFile(files?.item(0) ?? null);
                            }}
                          />
                          <Button
                            type="button"
                            onClick={() => void saveCredentialEdit(row)}
                          >
                            Save corrections
                          </Button>{' '}
                          <Button
                            type="button"
                            secondary
                            onClick={() => {
                              setEditingCredential(null);
                            }}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          secondary
                          onClick={() => {
                            startCredentialEdit(row);
                          }}
                        >
                          Correct pending credential
                        </Button>
                      )}
                    </>
                  )}
                  {[
                    'pending_review',
                    'verified',
                    'rejected',
                    'expired',
                  ].includes(row.status) && (
                    <Button
                      type="button"
                      secondary
                      disabled={credentialRevokeReason.trim().length < 8}
                      onClick={() => void revokeCredential(row)}
                    >
                      Revoke credential
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {!credentials.length && (
              <tr>
                <td colSpan={5}>No credentials have been submitted.</td>
              </tr>
            )}
          </tbody>
        </Table>
        <h3>Submit a credential</h3>
        <form onSubmit={(event) => void addCredential(event)}>
          <Field label="Credential type">
            <Select
              value={credentialTypeId}
              onChange={(event) => {
                setCredentialTypeId(event.target.value);
              }}
            >
              {types
                .filter((type) => type.active)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Credential number">
            <Input
              value={identifier}
              onChange={(event) => {
                setIdentifier(event.target.value);
              }}
              autoComplete="off"
            />
          </Field>
          <Field label="Issued on">
            <Input
              type="date"
              value={issuedOn}
              onChange={(event) => {
                setIssuedOn(event.target.value);
              }}
            />
          </Field>
          <Field label="Expires on">
            <Input
              type="date"
              value={expiresOn}
              onChange={(event) => {
                setExpiresOn(event.target.value);
              }}
            />
          </Field>
          <FileUpload
            label="Upload restricted credential document (PDF)"
            accept="application/pdf"
            onFiles={(files) => {
              setCredentialFile(files?.item(0) ?? null);
            }}
          />
          <Button type="submit" disabled={!credentialTypeId}>
            Submit for review
          </Button>
        </form>
      </Card>
      <Card>
        <h2>Injuries and return to play</h2>
        <form onSubmit={(event) => void reportInjury(event)}>
          <Field label="When did it happen?">
            <Input
              type="datetime-local"
              value={injuryOccurredAt}
              onChange={(event) => {
                setInjuryOccurredAt(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Describe the injury">
            <Textarea
              value={injuryDescription}
              onChange={(event) => {
                setInjuryDescription(event.target.value);
              }}
              required
            />
          </Field>
          <Field label="Suspected concussion">
            <Input
              type="checkbox"
              checked={concussion}
              onChange={(event) => {
                setConcussion(event.target.checked);
              }}
            />
          </Field>
          <Button type="submit">Report injury</Button>
        </form>
        <Table>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Details</th>
              <th scope="col">Status</th>
              <th scope="col">Clearance</th>
            </tr>
          </thead>
          <tbody>
            {injuries.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  {new Date(row.occurredAt).toLocaleDateString()}
                </th>
                <td>
                  {row.suspectedConcussion
                    ? 'Suspected concussion'
                    : row.description}
                </td>
                <td>{row.status.replaceAll('_', ' ')}</td>
                <td>
                  {['open', 'return_to_play_pending'].includes(row.status) && (
                    <>
                      <FileUpload
                        label="Upload medical clearance (PDF)"
                        accept="application/pdf"
                        onFiles={(files) => {
                          setClearanceFiles({
                            ...clearanceFiles,
                            [row.id]: files?.item(0) ?? null,
                          });
                        }}
                      />
                      <Field label="Provider name">
                        <Input
                          value={providerName}
                          onChange={(event) => {
                            setProviderName(event.target.value);
                          }}
                        />
                      </Field>
                      <Field label="Cleared on">
                        <Input
                          type="date"
                          value={clearedOn}
                          onChange={(event) => {
                            setClearedOn(event.target.value);
                          }}
                        />
                      </Field>
                      <Button
                        type="button"
                        onClick={() => void uploadClearance(row)}
                      >
                        Submit clearance
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!injuries.length && (
              <tr>
                <td colSpan={4}>No injury reports.</td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>
      <Card>
        <h2>Background check authorization</h2>
        {currentSettings?.disclosureText &&
        currentSettings.authorizationText ? (
          <form onSubmit={(event) => void startBackgroundCheck(event)}>
            <h3>Disclosure ({currentSettings.disclosureVersion})</h3>
            <p>{currentSettings.disclosureText}</p>
            <h3>Authorization ({currentSettings.authorizationVersion})</h3>
            <p>{currentSettings.authorizationText}</p>
            <Field label="I read the standalone disclosure and authorize the organization to request this background check">
              <Input
                type="checkbox"
                checked={accepted}
                onChange={(event) => {
                  setAccepted(event.target.checked);
                }}
              />
            </Field>
            <Button type="submit">Authorize background check</Button>
          </form>
        ) : (
          <p>
            Background-check consent has not been configured for this
            organization.
          </p>
        )}
        {backgroundCase && <p role="status">Check record {backgroundCase}</p>}
        <Table>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">State</th>
              <th scope="col">Candidate action</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  {new Date(row.createdAt).toLocaleDateString()}
                </th>
                <td>
                  {row.resultSummary ?? row.status} · {row.adjudication}
                </td>
                <td>
                  <Button
                    type="button"
                    secondary
                    onClick={() => void readCheck(row.id)}
                  >
                    Read report and notices
                  </Button>
                  {row.preAdverseNoticeAt && row.adjudication === 'pending' && (
                    <>
                      <Field label="Explain a report dispute">
                        <Textarea
                          value={disputeStatement}
                          onChange={(event) => {
                            setDisputeStatement(event.target.value);
                          }}
                        />
                      </Field>
                      <Button
                        type="button"
                        onClick={() => void submitDispute(row.id)}
                      >
                        Submit dispute
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!checks.length && (
              <tr>
                <td colSpan={3}>No background checks have been authorized.</td>
              </tr>
            )}
          </tbody>
        </Table>
        {checks.map(
          (row) =>
            checkDetails[row.id] && (
              <Card key={`check-${row.id}`}>
                <h3>Background-check record</h3>
                <p>
                  {checkDetails[row.id]?.resultSummary ??
                    checkDetails[row.id]?.status}{' '}
                  · adjudication {checkDetails[row.id]?.adjudication}
                </p>
                <p>
                  Pre-adverse notice:{' '}
                  {checkDetails[row.id]?.preAdverseNoticeAt
                    ? new Date(
                        checkDetails[row.id]?.preAdverseNoticeAt ?? '',
                      ).toLocaleString()
                    : 'Not sent'}
                </p>
                <h4>Rights information</h4>
                <p>{checkDetails[row.id]?.rightsSummaryText}</p>
                {checkDetails[row.id]?.details && (
                  <>
                    <h4>Report details</h4>
                    <pre>{checkDetails[row.id]?.details}</pre>
                  </>
                )}
                {(disputes[row.id] ?? []).map((dispute) => (
                  <section key={dispute.id}>
                    <h4>Dispute {dispute.status}</h4>
                    <p>{dispute.statement}</p>
                    {dispute.resolution && <p>{dispute.resolution}</p>}
                  </section>
                ))}
              </Card>
            ),
        )}
      </Card>
      <Card>
        <h2>Incident or SafeSport concern</h2>
        <form onSubmit={(event) => void reportConcern(event)}>
          <Field label="Category">
            <Select
              value={incidentCategory}
              onChange={(event) => {
                setIncidentCategory(event.target.value);
              }}
              options={[
                {
                  value: 'safesport_concern',
                  label: 'SafeSport concern (restricted)',
                },
                'safety',
                'behavior',
                'facility',
                'other',
              ]}
            />
          </Field>
          <Field label="What happened?">
            <Textarea
              value={incidentNarrative}
              onChange={(event) => {
                setIncidentNarrative(event.target.value);
              }}
              required
            />
          </Field>
          <Button type="submit">Send private report</Button>
        </form>
      </Card>
      <Card>
        <h2>Digital cards</h2>
        <div>
          {cards.map((row) => (
            <article key={row.id}>
              <h3>
                {row.cardKind} card {row.cardNumber}
              </h3>
              <p>
                Valid until {row.validUntil} · {row.status}
              </p>
              <QRCode
                value={row.verificationUrl}
                label={`Card ${row.cardNumber} verification QR`}
              />
            </article>
          ))}
        </div>
      </Card>
    </main>
  );
}

export function PublicCardVerification(): React.JSX.Element {
  const { token = '' } = useParams();
  const [card, setCard] = useState<z.infer<typeof publicCardSchema> | null>(
    null,
  );
  const [error, setError] = useState('');
  useEffect(() => {
    if (token.length < 30) return;
    void apiGet(`/compliance/cards/verify/${token}`, publicCardSchema)
      .then(setCard)
      .catch(() => {
        setError('This card is invalid, expired or revoked.');
      });
  }, [token]);
  return (
    <main>
      <Card>
        <h1>Card verification</h1>
        {error && <p role="alert">{error}</p>}
        {card && (
          <>
            <p>
              This {card.cardKind} card is valid through {card.validUntil}.
            </p>
            <p>
              <strong>{card.personName}</strong>
            </p>
            {card.teamName && (
              <>
                <p>Team: {card.teamName}</p>
                <p>Card number: {card.cardNumber}</p>
              </>
            )}
            {card.photoAvailable && card.photoUrl && (
              <img src={card.photoUrl} alt="Consented card holder" />
            )}
          </>
        )}
      </Card>
    </main>
  );
}
