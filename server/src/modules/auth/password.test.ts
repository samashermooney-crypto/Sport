import { describe, expect, it } from 'vitest';

import { hashPassword, passwordIssue, verifyPassword } from './password';

describe('password policy and Argon2id', () => {
  it('requires 10–256 code points and blocks the bundled common list', () => {
    expect(passwordIssue('short')).toBe('too_short');
    expect(passwordIssue('a'.repeat(257))).toBe('too_long');
    expect(passwordIssue('1234567890')).toBe('common');
    expect(passwordIssue('one simple phrase with spaces')).toBeNull();
  });

  it('hashes with the required parameters and verifies without exposing plaintext', async () => {
    const password = 'unique river bicycle 42';
    const encoded = await hashPassword(password);
    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(encoded, password)).toBe(true);
    expect(await verifyPassword(encoded, 'wrong password')).toBe(false);
  });
});
