import { isIP } from 'node:net';

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
    return false;
  const [first = 0, second = 0, third = 0] = parts;
  if (first < 1 || first > 223 || first === 127) return false;
  if (first === 10 || (first === 172 && second >= 16 && second <= 31))
    return false;
  if (first === 192 && second === 168) return false;
  if (first === 169 && second === 254) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 192 && second === 0 && third === 0) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function ipv6Words(address: string): number[] | null {
  if (address.includes('.')) return null;
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => '0'),
    ...right,
  ].map((part) => Number.parseInt(part, 16));
  return words.length === 8 && words.every(Number.isFinite) ? words : null;
}

function isPublicIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (!words) return false;
  const first = words[0] ?? 0;
  const second = words[1] ?? 0;
  // Only global unicast addresses are eligible. Exclude IANA special-use,
  // documentation, and 6to4 ranges from TLS verification targets.
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) return false;
  if (first === 0x2002) return false;
  return true;
}

export function isPublicWebsiteDomainAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? isPublicIpv4(address)
    : family === 6 && isPublicIpv6(address);
}
