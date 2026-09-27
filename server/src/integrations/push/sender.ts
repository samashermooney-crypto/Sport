import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { Agent } from 'node:https';
import { BlockList, isIPv4, isIPv6 } from 'node:net';

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

export type PushEndpointResolver = (
  hostname: string,
) => Promise<readonly LookupAddress[]>;

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4');
}

const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ['2001:db8::', 32],
  ['2001::', 32],
  ['2002::', 16],
  ['64:ff9b::', 96],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6');
}

const defaultPushEndpointResolver: PushEndpointResolver = (hostname) =>
  lookup(hostname, { all: true, order: 'verbatim' });

function isPublicAddress(address: LookupAddress): boolean {
  if (address.family === 4 && isIPv4(address.address))
    return !blockedIpv4.check(address.address, 'ipv4');
  if (address.family === 6 && isIPv6(address.address))
    return (
      globalIpv6.check(address.address, 'ipv6') &&
      !blockedIpv6.check(address.address, 'ipv6')
    );
  return false;
}

function pushProviderEndpoint(endpoint: string): URL | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const knownProvider =
    hostname === 'fcm.googleapis.com' ||
    hostname === 'updates.push.services.mozilla.com' ||
    hostname === 'push.apple.com' ||
    hostname.endsWith('.push.apple.com');
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.hash.length > 0 ||
    !knownProvider
  )
    return null;
  return url;
}

function pinnedAgent(
  expectedHostname: string,
  addresses: readonly LookupAddress[],
): Agent {
  return new Agent({
    keepAlive: false,
    lookup(hostname, options, callback) {
      if (hostname.toLowerCase().replace(/\.$/, '') !== expectedHostname) {
        callback(
          Object.assign(new Error('Push endpoint host changed'), {
            code: 'ENOTFOUND',
          }),
          '',
        );
        return;
      }
      const matching = addresses.filter(
        (address) => !options.family || address.family === options.family,
      );
      if (matching.length === 0) {
        callback(
          Object.assign(new Error('Pinned push address is unavailable'), {
            code: 'ENOTFOUND',
          }),
          '',
        );
        return;
      }
      if (options.all) {
        callback(null, matching);
        return;
      }
      const address = matching[0];
      if (!address) {
        callback(
          Object.assign(new Error('Pinned push address is unavailable'), {
            code: 'ENOTFOUND',
          }),
          '',
        );
        return;
      }
      callback(null, address.address, address.family);
    },
  });
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
    private readonly resolveEndpoint: PushEndpointResolver = defaultPushEndpointResolver,
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
    const endpoint = pushProviderEndpoint(subscription.endpoint);
    if (!endpoint) return { status: 'invalid-subscription' };
    const hostname = endpoint.hostname.toLowerCase().replace(/\.$/, '');
    const addresses = await this.resolveEndpoint(hostname);
    if (
      addresses.length === 0 ||
      addresses.some((item) => !isPublicAddress(item))
    )
      return { status: 'invalid-subscription' };
    const agent = pinnedAgent(hostname, addresses);
    try {
      const response = await this.client.sendNotification(
        subscription,
        JSON.stringify(message),
        { TTL: 3600, urgency: 'normal', agent },
      );
      const providerId = pushProviderId(response);
      return { status: 'sent', ...(providerId ? { providerId } : {}) };
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'statusCode' in error
          ? error.statusCode
          : undefined;
      if (status === 404 || status === 410)
        return { status: 'invalid-subscription' };
      throw error;
    } finally {
      agent.destroy();
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
