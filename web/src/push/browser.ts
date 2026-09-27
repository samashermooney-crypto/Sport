import { authStatusResponseSchema } from '@shared/schemas/auth';

import { ApiError, apiDelete } from '../api/client';

const deviceKey = 'athlentry-webpush-device-id';

export function storedPushDeviceId(): string | null {
  return localStorage.getItem(deviceKey);
}

export function rememberPushDeviceId(id: string): void {
  localStorage.setItem(deviceKey, id);
}

async function unsubscribe(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

export async function disconnectBrowserPush(): Promise<void> {
  const id = storedPushDeviceId();
  if (id) {
    try {
      await apiDelete(
        `/auth/devices/${encodeURIComponent(id)}`,
        authStatusResponseSchema,
      );
    } catch (caught) {
      if (!(caught instanceof ApiError && caught.status === 404)) throw caught;
    }
  }
  localStorage.removeItem(deviceKey);
  await unsubscribe().catch(() => undefined);
}

export function decodeVapidPublicKey(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const result = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1)
    result[index] = bytes.charCodeAt(index);
  if (result.length !== 65 || result[0] !== 4)
    throw new Error('Push configuration is invalid.');
  return result;
}
