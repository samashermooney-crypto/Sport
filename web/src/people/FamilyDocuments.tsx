import { familyPersonDocumentsSchema } from '@shared/schemas/people';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPost } from '../api/client';
import { ErrorBox } from '../ui/auth';
import { Button, Card, Field, Input, PageHeader } from '../ui/primitives';
import { AppShell } from '../ui/shell';

const uploadSchema = z.strictObject({
  fileId: z.uuid(),
  uploadUrl: z.string(),
});
const completeSchema = z.strictObject({ id: z.uuid() });
const downloadSchema = z.strictObject({
  url: z.string(),
  expiresInSeconds: z.number(),
});

function acceptedMime(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  return '';
}

export function FamilyDocuments(): React.JSX.Element {
  const { orgId = '', personId = '' } = useParams();
  const documents = useQuery({
    queryKey: ['people', orgId, personId, 'family-documents'],
    queryFn: () =>
      apiGet(
        `/people/orgs/${orgId}/${personId}/family-documents`,
        familyPersonDocumentsSchema,
      ),
    enabled: Boolean(orgId && personId),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(file: File | undefined): Promise<void> {
    if (!file || !orgId || !personId) return;
    const mime = acceptedMime(file);
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
        uploadSchema,
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
        completeSchema,
        undefined,
        { 'X-Athlentry-Org': orgId },
      );
      await documents.refetch();
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

  async function download(fileId: string): Promise<void> {
    if (!orgId) return;
    setError('');
    try {
      const response = await fetch(`/api/v1/files/${fileId}/download`, {
        credentials: 'include',
        headers: { 'X-Athlentry-Org': orgId },
      });
      if (!response.ok) throw new Error('Document is unavailable.');
      const link = downloadSchema.parse(await response.json());
      window.location.assign(link.url);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Document is unavailable.',
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
          title="Documents"
          description="Keep important records with this family profile. Access is limited to verified family members and authorized staff."
        />
        <p>
          <RouterLink to="/me/family">Back to family</RouterLink>
        </p>
        <ErrorBox error={error} />
        <Card>
          <h2>Upload a document</h2>
          <Field label="Choose a PDF, JPEG, or PNG file">
            <Input
              type="file"
              accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
              disabled={busy}
              onChange={(event) => void upload(event.currentTarget.files?.[0])}
            />
          </Field>
          {busy && <p role="status">Uploading document…</p>}
        </Card>
        <Card>
          <h2>Saved documents</h2>
          {documents.isPending && <p role="status">Loading documents…</p>}
          {documents.isError && <p>Documents could not be loaded.</p>}
          {documents.data?.items.length === 0 && (
            <p>No documents have been added.</p>
          )}
          <ul>
            {documents.data?.items.map((document) => (
              <li key={document.id}>
                {document.mime} · {Math.ceil(document.bytes / 1024)} KB ·{' '}
                {new Date(document.uploadedAt).toLocaleDateString()} ·{' '}
                <Button
                  type="button"
                  secondary
                  onClick={() => void download(document.id)}
                >
                  Open document
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      </main>
    </AppShell>
  );
}
