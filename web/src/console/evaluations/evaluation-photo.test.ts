import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { apiPost } from '../../api/client';

import { captureEvaluationParticipantPhoto } from './evaluation-photo';

vi.mock('../../api/client', () => ({ apiPost: vi.fn() }));

const orgId = '11111111-1111-4111-8111-111111111111';
const personId = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => vi.unstubAllGlobals());

it('uploads a camera photo, completes file processing and attaches it with the current consent version', async () => {
  vi.mocked(apiPost)
    .mockResolvedValueOnce({
      fileId,
      uploadUrl: '/api/v1/files/uploads/test/content',
    })
    .mockResolvedValueOnce({ id: fileId })
    .mockResolvedValueOnce({ id: personId });
  const file = new File(['image bytes'], 'athlete.png', { type: 'image/png' });

  await captureEvaluationParticipantPhoto({
    orgId,
    personId,
    personVersion: 7,
    mediaConsent: true,
    file,
  });

  expect(apiPost).toHaveBeenNthCalledWith(
    1,
    '/files/uploads',
    {
      purpose: 'image',
      mime: 'image/png',
      bytes: file.size,
      ownerType: 'person',
      ownerId: personId,
      sensitivity: 'sensitive',
    },
    expect.anything(),
    undefined,
    { 'X-Athlentry-Org': orgId },
  );
  expect(fetch).toHaveBeenCalledWith(
    '/api/v1/files/uploads/test/content',
    expect.objectContaining({
      method: 'PUT',
      body: file,
      credentials: 'include',
    }),
  );
  expect(apiPost).toHaveBeenNthCalledWith(
    3,
    `/people/orgs/${orgId}/${personId}/photo`,
    { expectedVersion: 7, fileId },
    expect.anything(),
  );
});

it('rejects photo capture without current media consent before starting an upload', async () => {
  const file = new File(['image bytes'], 'athlete.png', { type: 'image/png' });

  await expect(
    captureEvaluationParticipantPhoto({
      orgId,
      personId,
      personVersion: 7,
      mediaConsent: false,
      file,
    }),
  ).rejects.toThrow('Current media consent is required');
  expect(apiPost).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
