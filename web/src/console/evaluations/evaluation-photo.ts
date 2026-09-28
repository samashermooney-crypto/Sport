import { z } from 'zod';

import { apiPost } from '../../api/client';

const uploadSchema = z.object({ fileId: z.uuid(), uploadUrl: z.string() });
const fileSchema = z.looseObject({ id: z.uuid() });
const personSchema = z.looseObject({ id: z.uuid() });
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxImageBytes = 15 * 1024 * 1024;

export async function captureEvaluationParticipantPhoto(input: {
  orgId: string;
  personId: string;
  personVersion: number;
  mediaConsent: boolean;
  file: File;
}): Promise<void> {
  if (!input.mediaConsent)
    throw new Error(
      'Current media consent is required before capturing a photo.',
    );
  if (
    !imageTypes.has(input.file.type) ||
    input.file.size < 1 ||
    input.file.size > maxImageBytes
  )
    throw new Error('Choose a JPEG, PNG or WebP photo under 15 MB.');

  const upload = await apiPost(
    '/files/uploads',
    {
      purpose: 'image',
      mime: input.file.type,
      bytes: input.file.size,
      ownerType: 'person',
      ownerId: input.personId,
      sensitivity: 'sensitive',
    },
    uploadSchema,
    undefined,
    { 'X-Athlentry-Org': input.orgId },
  );
  const local = upload.uploadUrl.startsWith('/');
  const uploaded = await fetch(upload.uploadUrl, {
    method: 'PUT',
    body: input.file,
    credentials: local ? 'include' : 'omit',
    headers: {
      'Content-Type': input.file.type,
      ...(local
        ? { 'X-Athlentry-Request': '1', 'X-Athlentry-Org': input.orgId }
        : {}),
    },
  });
  if (!uploaded.ok) throw new Error('Photo upload failed.');

  await apiPost(
    `/files/uploads/${upload.fileId}/complete`,
    {},
    fileSchema,
    undefined,
    { 'X-Athlentry-Org': input.orgId },
  );
  await apiPost(
    `/people/orgs/${input.orgId}/${input.personId}/photo`,
    { expectedVersion: input.personVersion, fileId: upload.fileId },
    personSchema,
  );
}
