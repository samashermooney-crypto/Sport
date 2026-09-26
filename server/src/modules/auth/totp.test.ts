import { describe, expect, it } from 'vitest';

import {
  decodeBase32,
  encodeBase32,
  newTotpSecret,
  totpCode,
  verifyTotp,
} from './totp';

describe('TOTP verification', () => {
  it('matches the RFC 6238 SHA-1 vector truncated to six digits', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(totpCode(secret, 1)).toBe('287082');
    expect(decodeBase32(encodeBase32(secret))).toEqual(secret);
    expect(decodeBase32(newTotpSecret())).toHaveLength(20);
  });

  it('allows one neighboring step and rejects replayed codes', () => {
    const secret = Buffer.from('12345678901234567890');
    const code = totpCode(secret, 100);
    expect(verifyTotp(secret, code, 101 * 30_000, null)).toBe(100);
    expect(verifyTotp(secret, code, 101 * 30_000, 100)).toBeNull();
    expect(verifyTotp(secret, code, 102 * 30_000, null)).toBeNull();
    expect(verifyTotp(secret, '12345', 100 * 30_000, null)).toBeNull();
  });
});
