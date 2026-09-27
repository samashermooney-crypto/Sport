import {
  authPushConfigResponseSchema,
  authStatusResponseSchema,
  deviceResponseSchema,
  devicesResponseSchema,
} from '@shared/schemas/auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { apiDelete, apiGet, apiPost } from '../api/client';
import {
  decodeVapidPublicKey,
  disconnectBrowserPush,
  rememberPushDeviceId,
  storedPushDeviceId,
} from '../push/browser';
import { Button, ErrorBox } from '../ui/auth';

const supported =
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

export function BrowserPush(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [currentId, setCurrentId] = useState(() => storedPushDeviceId());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const config = useQuery({
    queryKey: ['auth', 'push-config'],
    queryFn: () => apiGet('/auth/push-config', authPushConfigResponseSchema),
    enabled: supported,
  });
  const devices = useQuery({
    queryKey: ['auth', 'devices'],
    queryFn: () => apiGet('/auth/devices', devicesResponseSchema),
  });
  const activeHere = Boolean(
    currentId &&
    devices.data?.devices.some((device) => device.id === currentId),
  );

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Browser notification settings could not be changed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function enable(): Promise<void> {
    await run(async () => {
      if (!config.data) throw new Error('Push configuration is unavailable.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted')
        throw new Error('Notifications were not allowed in this browser.');
      await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
      });
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) await existing.unsubscribe();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidPublicKey(config.data.publicKey),
      });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
        await subscription.unsubscribe();
        throw new Error('Browser subscription was incomplete.');
      }
      const device = await apiPost(
        '/auth/devices',
        {
          platform: 'webpush',
          subscription: {
            endpoint: json.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          },
        },
        deviceResponseSchema,
      ).catch(async (caught: unknown) => {
        await subscription.unsubscribe();
        throw caught;
      });
      rememberPushDeviceId(device.id);
      setCurrentId(device.id);
      await queryClient.invalidateQueries({ queryKey: ['auth', 'devices'] });
      setNotice('Browser notifications enabled on this device.');
    });
  }

  async function revoke(id: string): Promise<void> {
    await run(async () => {
      if (id === currentId) {
        await disconnectBrowserPush();
        setCurrentId(null);
      } else {
        await apiDelete(`/auth/devices/${id}`, authStatusResponseSchema);
      }
      await queryClient.invalidateQueries({ queryKey: ['auth', 'devices'] });
      setNotice('Notification device revoked.');
    });
  }

  return (
    <section className="security-section" aria-labelledby="push-heading">
      <h2 id="push-heading">Browser notifications</h2>
      <p>Register this browser to receive account notifications.</p>
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}
      {supported && config.isError && (
        <ErrorBox error="Push configuration could not be loaded." />
      )}
      {supported && config.isSuccess && !activeHere && (
        <Button type="button" disabled={busy} onClick={() => void enable()}>
          Enable browser notifications
        </Button>
      )}
      {devices.isPending && <p role="status">Loading registered devices…</p>}
      {devices.isError && (
        <ErrorBox error="Registered devices could not be loaded." />
      )}
      {devices.data?.devices.map((device) => (
        <div className="session-row" key={device.id}>
          <div>
            <strong>
              {device.platform === 'webpush'
                ? 'Browser'
                : device.platform.toUpperCase()}
            </strong>
            <small>
              Last registered {new Date(device.lastSeenAt).toLocaleString()}
            </small>
          </div>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void revoke(device.id)}
          >
            Revoke device
          </Button>
        </div>
      ))}
    </section>
  );
}
