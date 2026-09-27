import { personResponseSchema } from '@shared/schemas/people';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { apiPost } from '../api/client';
import { ErrorBox } from '../ui/auth';
import { Button, Field, Input } from '../ui/primitives';

type Person = z.output<typeof personResponseSchema>;
const beginSchema = z.object({ fileId: z.uuid(), uploadUrl: z.string() });
const completeSchema = z.object({ id: z.uuid() });

async function readPhoto(orgId: string, fileId: string): Promise<string> {
  const link = await fetch(`/api/v1/files/${fileId}/download`, {
    credentials: 'include',
    headers: { 'X-Athlentry-Org': orgId },
  });
  if (!link.ok) throw new Error('Photo could not be loaded');
  const data = (await link.json()) as { url: string };
  const local = data.url.startsWith('/');
  const content = await fetch(data.url, {
    credentials: local ? 'include' : 'omit',
    headers: local ? { 'X-Athlentry-Org': orgId } : {},
  });
  if (!content.ok) throw new Error('Photo could not be loaded');
  return URL.createObjectURL(await content.blob());
}

export function PersonPhoto({
  orgId,
  person,
  onSaved,
}: {
  orgId: string;
  person: Person;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [existingUrl, setExistingUrl] = useState<string | null>(null);
  const [x, setX] = useState(50);
  const [y, setY] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!file) return;
    let active = true;
    void createImageBitmap(file)
      .then((image) => {
        if (active) setBitmap(image);
        else image.close();
      })
      .catch(() => {
        if (active) setError('Choose a supported image file.');
      });
    return () => {
      active = false;
    };
  }, [file]);
  useEffect(() => () => bitmap?.close(), [bitmap]);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context || !bitmap) return;
    const side = Math.min(bitmap.width, bitmap.height) / zoom;
    context.drawImage(
      bitmap,
      ((bitmap.width - side) * x) / 100,
      ((bitmap.height - side) * y) / 100,
      side,
      side,
      0,
      0,
      512,
      512,
    );
  }, [bitmap, x, y, zoom]);
  useEffect(() => {
    if (!person.photoFileId) return;
    let active = true;
    let url: string | null = null;
    void readPhoto(orgId, person.photoFileId)
      .then((value) => {
        url = value;
        if (active) setExistingUrl(value);
        else URL.revokeObjectURL(value);
      })
      .catch(() => {
        if (active) setError('Photo could not be loaded.');
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [orgId, person.photoFileId]);

  async function savePhoto(): Promise<void> {
    if (!file || !canvas.current) return;
    setBusy(true);
    setError('');
    try {
      const cropped = await new Promise<Blob>((resolve, reject) => {
        canvas.current?.toBlob(
          (blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Photo could not be cropped'));
          },
          'image/jpeg',
          0.9,
        );
      });
      const upload = await apiPost(
        '/files/uploads',
        {
          purpose: 'image',
          mime: 'image/jpeg',
          bytes: cropped.size,
          ownerType: 'person',
          ownerId: person.id,
          sensitivity: 'sensitive',
        },
        beginSchema,
        undefined,
        { 'X-Athlentry-Org': orgId },
      );
      const local = upload.uploadUrl.startsWith('/');
      const put = await fetch(upload.uploadUrl, {
        method: 'PUT',
        body: cropped,
        credentials: local ? 'include' : 'omit',
        headers: {
          'Content-Type': 'image/jpeg',
          ...(local
            ? { 'X-Athlentry-Request': '1', 'X-Athlentry-Org': orgId }
            : {}),
        },
      });
      if (!put.ok) throw new Error('Photo upload failed');
      await apiPost(
        `/files/uploads/${upload.fileId}/complete`,
        {},
        completeSchema,
        undefined,
        {
          'X-Athlentry-Org': orgId,
        },
      );
      await apiPost(
        `/people/orgs/${orgId}/${person.id}/photo`,
        {
          expectedVersion: person.version,
          fileId: upload.fileId,
        },
        personResponseSchema,
      );
      setFile(null);
      setBitmap(null);
      await onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Photo could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await apiPost(
        `/people/orgs/${orgId}/${person.id}/photo`,
        {
          expectedVersion: person.version,
          fileId: null,
        },
        personResponseSchema,
      );
      await onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Photo could not be removed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Person photo">
      <h3>Photo</h3>
      <ErrorBox error={error} />
      {existingUrl && person.photoFileId && (
        <span className="ui-avatar ui-avatar-large">
          <img
            src={existingUrl}
            alt={`${person.firstName} ${person.lastName}`}
          />
        </span>
      )}
      {person.mediaConsent !== 'granted' ? (
        <p>Grant media consent in this profile before adding a photo.</p>
      ) : (
        <>
          <Field label="Choose photo">
            <Input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setBitmap(null);
                setError('');
                setX(50);
                setY(50);
                setZoom(1);
              }}
            />
          </Field>
          {file && (
            <>
              <canvas
                ref={canvas}
                width={512}
                height={512}
                role="img"
                aria-label="Photo crop preview"
                style={{
                  width: 'min(100%, 260px)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-8)',
                }}
              />
              <Field label="Crop left or right">
                <Input
                  type="range"
                  min="0"
                  max="100"
                  value={x}
                  onChange={(event) => {
                    setX(Number(event.target.value));
                  }}
                />
              </Field>
              <Field label="Crop up or down">
                <Input
                  type="range"
                  min="0"
                  max="100"
                  value={y}
                  onChange={(event) => {
                    setY(Number(event.target.value));
                  }}
                />
              </Field>
              <Field label="Zoom crop">
                <Input
                  type="range"
                  min="1"
                  max="3"
                  step="0.1"
                  value={zoom}
                  onChange={(event) => {
                    setZoom(Number(event.target.value));
                  }}
                />
              </Field>
              <Button
                type="button"
                disabled={busy || !bitmap}
                onClick={() => {
                  void savePhoto();
                }}
              >
                Crop and upload photo
              </Button>
            </>
          )}
          {person.photoFileId && (
            <Button
              type="button"
              secondary
              disabled={busy}
              onClick={() => {
                void removePhoto();
              }}
            >
              Remove photo
            </Button>
          )}
        </>
      )}
    </section>
  );
}
