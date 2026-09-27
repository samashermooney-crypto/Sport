import {
  authPushConfigResponseSchema,
  authStatusResponseSchema,
  deviceResponseSchema,
  devicesResponseSchema,
} from '@shared/schemas/auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

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
  const { t, i18n } = useTranslation('auth');
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
        caught instanceof Error ? caught.message : t('browserSettingsFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function enable(): Promise<void> {
    await run(async () => {
      if (!config.data) throw new Error(t('pushConfigUnavailable'));
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error(t('notificationsDenied'));
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
        throw new Error(t('subscriptionIncomplete'));
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
      setNotice(t('browserEnabled'));
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
      setNotice(t('deviceRevoked'));
    });
  }

  return (
    <section className="security-section" aria-labelledby="push-heading">
      <h2 id="push-heading">{t('browserNotifications')}</h2>
      <p>{t('browserNotificationsDescription')}</p>
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}
      {supported && config.isError && (
        <ErrorBox error={t('pushConfigFailed')} />
      )}
      {supported && config.isSuccess && !activeHere && (
        <Button type="button" disabled={busy} onClick={() => void enable()}>
          {t('enableBrowserNotifications')}
        </Button>
      )}
      {devices.isPending && <p role="status">{t('loadingDevices')}</p>}
      {devices.isError && <ErrorBox error={t('devicesFailed')} />}
      {devices.data?.devices.map((device) => (
        <div className="session-row" key={device.id}>
          <div>
            <strong>
              {device.platform === 'webpush'
                ? t('browserDevice')
                : device.platform.toUpperCase()}
            </strong>
            <small>
              {t('lastRegistered', {
                date: new Date(device.lastSeenAt).toLocaleString(
                  i18n.resolvedLanguage,
                ),
              })}
            </small>
          </div>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void revoke(device.id)}
          >
            {t('revokeDevice')}
          </Button>
        </div>
      ))}
    </section>
  );
}
