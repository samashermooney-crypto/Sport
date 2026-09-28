import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

export type PushAddressResolver = (
  hostname: string,
) => Promise<readonly LookupAddress[]>;

export class UnsafePushDestinationError extends Error {
  constructor() {
    super('Push subscription destination is not allowed');
    this.name = 'UnsafePushDestinationError';
  }
}

const trustedProviderDomains = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
];

function trustedProviderHost(hostname: string): boolean {
  return trustedProviderDomains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

function publicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255))
    return false;
  const [first, second, third] = octets;
  if (first === undefined || second === undefined || third === undefined)
    return false;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function publicIpv6(address: string): boolean {
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  const segments = normalized.split(':');
  const first = Number.parseInt(segments[0] ?? '', 16);
  const second =
    segments[1] === '' ? 0 : Number.parseInt(segments[1] ?? '', 16);
  if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff)
    return false;
  if (first === 0x2002) return false; // 6to4 embeds an IPv4 destination.
  if (first === 0x2001 && second <= 0x01ff) return false; // IETF assignments.
  if (normalized.startsWith('2001:db8:')) return false;
  if (first === 0x3fff && second <= 0x0fff) return false; // Documentation.
  return true;
}

function publicAddress(record: LookupAddress): boolean {
  return record.family === 4
    ? isIP(record.address) === 4 && publicIpv4(record.address)
    : publicIpv6(record.address);
}

function dnsLookupAll(hostname: string): Promise<readonly LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function pinnedLookup(
  hostname: string,
  addresses: readonly LookupAddress[],
): LookupFunction {
  return (requestedHostname, options, callback) => {
    if (requestedHostname.toLowerCase() !== hostname) {
      callback(
        Object.assign(new Error('Unexpected push host'), { code: 'EACCES' }),
        '',
        0,
      );
      return;
    }
    const selected = addresses.find(
      (address) => !options.family || address.family === options.family,
    );
    if (!selected) {
      callback(
        Object.assign(new Error('Push host family is unavailable'), {
          code: 'EAI_ADDRFAMILY',
        }),
        '',
        0,
      );
      return;
    }
    if (options.all) callback(null, [selected]);
    else callback(null, selected.address, selected.family);
  };
}

export async function createPushHttpsAgent(
  endpoint: string,
  resolveAddresses: PushAddressResolver = dnsLookupAll,
): Promise<https.Agent> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new UnsafePushDestinationError();
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    hostname.endsWith('.') ||
    isIP(hostname) !== 0 ||
    !trustedProviderHost(hostname)
  ) {
    throw new UnsafePushDestinationError();
  }

  const addresses = await resolveAddresses(hostname);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !publicAddress(address))
  )
    throw new UnsafePushDestinationError();

  return new https.Agent({
    keepAlive: false,
    lookup: pinnedLookup(hostname, addresses),
  });
}
