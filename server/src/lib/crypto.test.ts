import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decryptRestricted,
  encryptRestricted,
  parseEncryptionKeys,
} from './crypto';

describe('restricted field encryption', () => {
  it('round-trips with AES-256-GCM and detects tampering', () => {
    const key = randomBytes(32);
    const encryption = parseEncryptionKeys(
      JSON.stringify({ k1: key.toString('base64') }),
      'k1',
    );
    const ciphertext = encryptRestricted(
      Buffer.from('medical detail'),
      encryption,
    );
    expect(ciphertext.includes(Buffer.from('medical detail'))).toBe(false);
    expect(decryptRestricted(ciphertext, encryption).toString()).toBe(
      'medical detail',
    );
    ciphertext[ciphertext.length - 1] =
      (ciphertext[ciphertext.length - 1] ?? 0) ^ 1;
    expect(() => decryptRestricted(ciphertext, encryption)).toThrow();
  });

  it('requires a valid active 32-byte key', () => {
    expect(() => parseEncryptionKeys('{}', 'missing')).toThrow();
    expect(() => parseEncryptionKeys('{"k1":"AA=="}', 'k1')).toThrow();
  });
});
