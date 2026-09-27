import {
  orgCredentialSchema,
  orgCredentialsResponseSchema,
} from '@shared/schemas/orgs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import type { z } from 'zod';

import { apiGet, apiPatch } from '../api/client';
import { AuthFrame, AuthLink, ErrorBox } from '../ui/auth';
import { Button, Field, Input } from '../ui/primitives';

type Credential = z.output<typeof orgCredentialSchema>;

function CredentialEditor({
  credential,
  orgId,
  readOnly,
}: {
  credential: Credential;
  orgId: string;
  readOnly: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(credential);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function save(): Promise<void> {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const updated = await apiPatch(
        `/orgs/${orgId}/credential-types/${credential.id}`,
        {
          name: draft.name,
          validityMonths: draft.validityMonths,
          blocksActivation: draft.blocksActivation,
          active: draft.active,
          version: draft.version,
        },
        orgCredentialSchema,
      );
      setDraft(updated);
      setSaved(true);
      await queryClient.invalidateQueries({
        queryKey: ['orgs', orgId, 'credential-types'],
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Credential update failed.',
      );
    } finally {
      setBusy(false);
    }
  }
  if (readOnly)
    return (
      <section className="start-credential-card" aria-label={credential.name}>
        <h2>{credential.name}</h2>
        <p>
          Verification method: {credential.verification.replaceAll('_', ' ')}
        </p>
        <p>Valid for {credential.validityMonths} months</p>
        <p>
          {credential.blocksActivation
            ? 'Blocks staff activation'
            : 'Does not block staff activation'}
        </p>
        <p>{credential.active ? 'Active' : 'Disabled'}</p>
      </section>
    );
  return (
    <section className="start-credential-card" aria-label={credential.name}>
      <h2>{credential.name}</h2>
      <ErrorBox error={error} />
      {saved && <p role="status">Safety requirement saved.</p>}
      <Field label="Name" required>
        <Input
          value={draft.name}
          onChange={(event) => {
            setDraft({ ...draft, name: event.target.value });
          }}
        />
      </Field>
      <p>Verification method: {draft.verification.replaceAll('_', ' ')}</p>
      <Field label="Valid for months" required>
        <Input
          type="number"
          min={1}
          max={120}
          value={draft.validityMonths}
          onChange={(event) => {
            setDraft({ ...draft, validityMonths: Number(event.target.value) });
          }}
        />
      </Field>
      <label className="start-credential-check">
        <input
          type="checkbox"
          checked={draft.blocksActivation}
          onChange={(event) => {
            setDraft({ ...draft, blocksActivation: event.target.checked });
          }}
        />{' '}
        Block staff activation until verified
      </label>
      <label className="start-credential-check">
        <input
          type="checkbox"
          checked={draft.active}
          onChange={(event) => {
            setDraft({ ...draft, active: event.target.checked });
          }}
        />{' '}
        Requirement active
      </label>
      <Button type="button" disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save requirement'}
      </Button>
    </section>
  );
}

export function Credentials(): React.JSX.Element {
  const { orgId } = useParams();
  const readOnly = Boolean(sessionStorage.getItem('athlentry.impersonation'));
  const query = useQuery({
    queryKey: ['orgs', orgId, 'credential-types'],
    queryFn: () =>
      apiGet(
        `/orgs/${String(orgId)}/credential-types`,
        orgCredentialsResponseSchema,
      ),
    enabled: Boolean(orgId),
    retry: false,
  });
  return (
    <AuthFrame footer={<AuthLink to="/me">Back to your account</AuthLink>}>
      <h1>Safety requirements</h1>
      {readOnly && (
        <p role="status">Viewing as platform staff. Changes are disabled.</p>
      )}
      <p>
        These requirements are created for your organization. An owner can edit
        or disable each one after confirming their identity in{' '}
        <AuthLink to="/me/security">account security</AuthLink>.
      </p>
      {query.isPending && <p role="status">Loading requirements…</p>}
      {query.isError && (
        <ErrorBox error="Requirements could not be loaded. Confirm your owner role is active and try again." />
      )}
      {query.isSuccess && (
        <div className="start-credential-list">
          {query.data.map((credential) => (
            <CredentialEditor
              key={credential.id}
              credential={credential}
              orgId={String(orgId)}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </AuthFrame>
  );
}
