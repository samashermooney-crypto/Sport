import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptionKeys {
  activeKid: string;
  keys: ReadonlyMap<string, Buffer>;
}

export function parseEncryptionKeys(
  json: string,
  activeKid: string,
): EncryptionKeys {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DATA_ENCRYPTION_KEYS must be an object');
  }
  const keys = new Map<string, Buffer>();
  for (const [kid, encoded] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid) || typeof encoded !== 'string') {
      throw new Error('Invalid encryption key id or value');
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) {
      throw new Error(`Encryption key ${kid} must be 32-byte base64`);
    }
    keys.set(kid, key);
  }
  if (!keys.has(activeKid)) throw new Error('Active encryption key is missing');
  return { activeKid, keys };
}

export function encryptRestricted(
  plaintext: Buffer,
  encryption: EncryptionKeys,
): Buffer {
  const key = encryption.keys.get(encryption.activeKid);
  if (!key) throw new Error('Active encryption key is missing');
  const kid = Buffer.from(encryption.activeKid, 'utf8');
  if (kid.length > 255) throw new RangeError('Encryption key id is too long');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([
    Buffer.from([kid.length]),
    kid,
    nonce,
    body,
    cipher.getAuthTag(),
  ]);
}

export function decryptRestricted(
  encrypted: Buffer,
  encryption: EncryptionKeys,
): Buffer {
  if (encrypted.length < 1 + 1 + 12 + 16)
    throw new Error('Encrypted value is truncated');
  const kidLength = encrypted[0];
  if (
    kidLength === undefined ||
    kidLength === 0 ||
    encrypted.length < 1 + kidLength + 28
  ) {
    throw new Error('Encrypted value has invalid key id');
  }
  const kid = encrypted.subarray(1, 1 + kidLength).toString('utf8');
  const key = encryption.keys.get(kid);
  if (!key) throw new Error('Encryption key is unavailable');
  const nonceStart = 1 + kidLength;
  const nonce = encrypted.subarray(nonceStart, nonceStart + 12);
  const tag = encrypted.subarray(encrypted.length - 16);
  const body = encrypted.subarray(nonceStart + 12, encrypted.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
