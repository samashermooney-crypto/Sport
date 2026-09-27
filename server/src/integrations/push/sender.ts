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
    },
  ): Promise<unknown>;
}
export interface PushSender {
  send(
    subscription: PushSubscription,
    message: PushMessage,
  ): Promise<'sent' | 'invalid-subscription'>;
}
export interface PushSubscriptionCleanup {
  removeInvalidEndpoint(endpoint: string): Promise<void>;
}
export async function sendPushAndCleanup(
  sender: PushSender,
  subscription: PushSubscription,
  message: PushMessage,
  cleanup: PushSubscriptionCleanup,
): Promise<'sent' | 'invalid-subscription'> {
  const outcome = await sender.send(subscription, message);
  if (outcome === 'invalid-subscription')
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
    return Promise.resolve('sent' as const);
  }
}
export class PreviewPushSender extends FakePushSender {}
/** Uses the standard web-push library supplied by the application composition root. */
export class WebPushSender implements PushSender {
  constructor(
    client: WebPushClient,
    config: { subject: string; publicKey: string; privateKey: string },
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
  ): Promise<'sent' | 'invalid-subscription'> {
    try {
      await this.client.sendNotification(
        subscription,
        JSON.stringify(message),
        { TTL: 3600, urgency: 'normal' },
      );
      return 'sent';
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'statusCode' in error
          ? error.statusCode
          : undefined;
      if (status === 404 || status === 410) return 'invalid-subscription';
      throw error;
    }
  }
}
