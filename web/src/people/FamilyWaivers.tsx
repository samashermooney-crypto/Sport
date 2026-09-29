import { familyResponseSchema } from '@shared/schemas/people';
import {
  waiverDocumentListSchema,
  waiverSignatureListSchema,
  waiverSignatureSchema,
} from '@shared/schemas/waivers';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';

import { apiGet, apiPost } from '../api/client';
import { ErrorBox } from '../ui/auth';
import { Button, Card, Field, Input, PageHeader } from '../ui/primitives';
import { AppShell } from '../ui/shell';

export function FamilyWaivers(): React.JSX.Element {
  const { orgId = '', personId = '' } = useParams();
  const [signerNames, setSignerNames] = useState<Record<string, string>>({});
  const [busyWaiver, setBusyWaiver] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const family = useQuery({
    queryKey: ['people', 'me', 'family'],
    queryFn: () => apiGet('/people/me/family', familyResponseSchema),
  });
  const person = family.data?.organizations
    .find((organization) => organization.orgId === orgId)
    ?.people.find((member) => member.personId === personId);
  const documents = useQuery({
    queryKey: ['waivers', orgId, personId, 'family'],
    queryFn: () =>
      apiGet(
        `/waivers/orgs/${orgId}/person?personId=${personId}`,
        waiverDocumentListSchema,
      ),
    enabled: Boolean(orgId && personId),
  });
  const signatures = useQuery({
    queryKey: ['waivers', orgId, personId, 'signatures'],
    queryFn: () =>
      apiGet(
        `/waivers/orgs/${orgId}/signatures?participantPersonId=${personId}`,
        waiverSignatureListSchema,
      ),
    enabled: Boolean(orgId && personId),
  });

  async function sign(waiverId: string): Promise<void> {
    if (!orgId || !personId) return;
    const signerNameTyped = (signerNames[waiverId] ?? '').trim();
    if (!signerNameTyped) {
      setError('Enter the signer’s full name before accepting.');
      return;
    }
    setBusyWaiver(waiverId);
    setError('');
    setSuccess('');
    try {
      const result = await apiPost(
        `/waivers/orgs/${orgId}/${waiverId}/signatures`,
        {
          participantPersonId: personId,
          signerPersonId: person?.relationship === 'self' ? personId : null,
          signerNameTyped,
          method: 'online_typed',
        },
        waiverSignatureSchema,
      );
      await signatures.refetch();
      setSignerNames((current) => ({ ...current, [waiverId]: '' }));
      setSuccess(
        `Waiver signed at ${new Date(result.signedAt).toLocaleString()}.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Waiver could not be signed.',
      );
    } finally {
      setBusyWaiver(null);
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
          title="Waivers"
          description="Review the current document before signing. Signed records stay attached to their exact version."
        />
        <p>
          <RouterLink to="/me/family">Back to family</RouterLink>
        </p>
        <ErrorBox error={error} />
        {success && <p role="status">{success}</p>}
        {documents.isPending && <p role="status">Loading waivers…</p>}
        {(family.isError || documents.isError || signatures.isError) && (
          <Card>
            <p>Waiver records are unavailable.</p>
          </Card>
        )}
        {documents.data?.items.length === 0 && (
          <Card>
            <p>There are no current waivers for this profile.</p>
          </Card>
        )}
        {documents.data?.items.map((document) => {
          const existing =
            signatures.data?.items.filter(
              (signature) =>
                signature.waiverDocumentId === document.id &&
                signature.documentVersion === document.version,
            ) ?? [];
          const participantSigned = existing.some(
            (signature) => signature.signerPersonId === personId,
          );
          const guardianSigned = existing.some(
            (signature) => signature.signerPersonId !== personId,
          );
          const isMinor = (person?.age ?? 0) < 18;
          const isGuardian = person?.relationship === 'guardian';
          const isSelf = person?.relationship === 'self';
          const signingAsParticipant = !isMinor && isSelf;
          const signingAsGuardian =
            ((document.requires === 'guardian_if_minor' && isMinor) ||
              (document.requires === 'both' && !isMinor)) &&
            isGuardian;
          const completed =
            document.requires === 'both'
              ? participantSigned && guardianSigned
              : existing.length > 0;
          const canSign =
            !completed &&
            (signingAsParticipant
              ? !participantSigned
              : signingAsGuardian && !guardianSigned);
          return (
            <Card key={document.id}>
              <h2>{document.name}</h2>
              <p>
                Version {document.version} · Renewal:{' '}
                {document.renewal.replaceAll('_', ' ')}
              </p>
              <div className="document-copy" style={{ whiteSpace: 'pre-wrap' }}>
                {document.bodyText}
              </div>
              {existing.length > 0 && (
                <section aria-label={`Signatures for ${document.name}`}>
                  <h3>Signatures received</h3>
                  <ul>
                    {existing.map((signature) => (
                      <li key={signature.id}>
                        {signature.signerNameTyped} ·{' '}
                        {new Date(signature.signedAt).toLocaleString()} ·{' '}
                        <a
                          href={`/api/v1/waivers/orgs/${orgId}/signatures/${signature.id}/pdf`}
                        >
                          Download signed PDF
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {completed ? (
                <p role="status">All required signatures are complete.</p>
              ) : canSign ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void sign(document.id);
                  }}
                >
                  <Field label="Type your full legal name" required>
                    <Input
                      autoComplete="name"
                      value={signerNames[document.id] ?? ''}
                      onChange={(event) => {
                        setSignerNames((current) => ({
                          ...current,
                          [document.id]: event.target.value,
                        }));
                      }}
                    />
                  </Field>
                  <Button type="submit" disabled={busyWaiver === document.id}>
                    {busyWaiver === document.id
                      ? 'Signing…'
                      : 'I have read and agree'}
                  </Button>
                </form>
              ) : document.requires === 'both' && isMinor ? (
                <p>
                  This waiver requires an adult participant and a guardian. It
                  cannot be used for a minor.
                </p>
              ) : (
                <p>
                  This profile does not have a signer role required for this
                  waiver, or its required signer has already signed.
                </p>
              )}
            </Card>
          );
        })}
      </main>
    </AppShell>
  );
}
