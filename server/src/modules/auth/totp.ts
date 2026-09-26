import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const stepMilliseconds = 30_000;

export function encodeBase32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      const character = alphabet[(value >>> (bits - 5)) & 31];
      if (!character) throw new Error('Base32 encoding failed');
      output += character;
      bits -= 5;
    }
  }
  if (bits > 0) {
    const character = alphabet[(value << (5 - bits)) & 31];
    if (!character) throw new Error('Base32 encoding failed');
    output += character;
  }
  return output;
}

export function decodeBase32(encoded: string): Buffer {
  if (!/^[A-Z2-7]+$/.test(encoded))
    throw new RangeError('Invalid base32 secret');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of encoded) {
    const index = alphabet.indexOf(character);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function newTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpCode(secret: Buffer, step: number): string {
  if (!Number.isSafeInteger(step) || step < 0)
    throw new RangeError('Invalid TOTP step');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 15;
  const truncated = (digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000;
  return String(truncated).padStart(6, '0');
}

export function verifyTotp(
  secret: Buffer,
  candidate: string,
  nowMilliseconds: number,
  lastUsedStep: number | null,
): number | null {
  if (
    !/^\d{6}$/.test(candidate) ||
    !Number.isSafeInteger(nowMilliseconds) ||
    nowMilliseconds < 0
  ) {
    return null;
  }
  const current = Math.floor(nowMilliseconds / stepMilliseconds);
  let accepted: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0) continue;
    const expected = totpCode(secret, step);
    if (
      timingSafeEqual(Buffer.from(candidate), Buffer.from(expected)) &&
      (lastUsedStep === null || step > lastUsedStep)
    ) {
      accepted = step;
    }
  }
  return accepted;
}
