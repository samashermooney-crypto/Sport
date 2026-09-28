import type { Agent } from 'node:https';

import {
  createPushHttpsAgent,
  UnsafePushDestinationError,
} from './destination';
import type { PushAddressResolver } from './destination';

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}
export interface WebPushClient {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: PushSubscription,
    payload: string,
    options?: {
      TTL?: number;
      urgency?: 'very-low' | 'low' | 'normal' | 'high';
      agent?: Agent;
    },
  ): Promise<unknown>;
}
export interface PushSender {
  send(
    subscription: PushSubscription,
    message: PushMessage,
  ): Promise<PushDeliveryResult>;
}
export type PushDeliveryResult =
  { status: 'sent'; providerId?: string } | { status: 'invalid-subscription' };
export interface PushSubscriptionCleanup {
  removeInvalidEndpoint(endpoint: string): Promise<void>;
}
export async function sendPushAndCleanup(
  sender: PushSender,
  subscription: PushSubscription,
  message: PushMessage,
  cleanup: PushSubscriptionCleanup,
): Promise<PushDeliveryResult> {
  const outcome = await sender.send(subscription, message);
  if (outcome.status === 'invalid-subscription')
    await cleanup.removeInvalidEndpoint(subscription.endpoint);
  return outcome;
}
export class FakePushSender implements PushSender {
  readonly deliveries: Array<{
    subscription: PushSubscription;
    message: PushMessage;
  }> = [];
  send(subscription: PushSubscription, message: PushMessage) {
    this.deliveries.push({ subscription, message });
    return Promise.resolve({
      status: 'sent' as const,
      providerId: `fake-push-${String(this.deliveries.length)}`,
    });
  }
}
export class PreviewPushSender extends FakePushSender {}
/** Uses the standard web-push library supplied by the application composition root. */
export class WebPushSender implements PushSender {
  constructor(
    client: WebPushClient,
    config: { subject: string; publicKey: string; privateKey: string },
    private readonly resolveAddresses?: PushAddressResolver,
  ) {
    if (
      !config.subject.startsWith('mailto:') &&
      !config.subject.startsWith('https://')
    )
      throw new Error('VAPID subject must be a mailto: or https: URL');
    client.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    this.client = client;
  }
  private readonly client: WebPushClient;
  async send(
    subscription: PushSubscription,
    message: PushMessage,
  ): Promise<PushDeliveryResult> {
    let agent: Agent | undefined;
    try {
      agent = await createPushHttpsAgent(
        subscription.endpoint,
        this.resolveAddresses,
      );
      const response = await this.client.sendNotification(
        subscription,
        JSON.stringify(message),
        { TTL: 3600, urgency: 'normal', agent },
      );
      const providerId = pushProviderId(response);
      return { status: 'sent', ...(providerId ? { providerId } : {}) };
    } catch (error) {
      if (error instanceof UnsafePushDestinationError)
        return { status: 'invalid-subscription' };
      const status =
        error && typeof error === 'object' && 'statusCode' in error
          ? error.statusCode
          : undefined;
      if (status === 404 || status === 410)
        return { status: 'invalid-subscription' };
      throw error;
    } finally {
      agent?.destroy();
    }
  }
}

function pushProviderId(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const responseRecord = response as Record<string, unknown>;
  for (const key of ['providerId', 'messageId', 'id']) {
    const value = responseRecord[key];
    if (typeof value === 'string' && value) return value;
  }
  const headers = responseRecord.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers)
    return (
      headers.get('x-message-id') ?? headers.get('message-id') ?? undefined
    );
  const headerRecord = headers as Record<string, unknown>;
  for (const key of ['x-message-id', 'message-id']) {
    const value = headerRecord[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}
