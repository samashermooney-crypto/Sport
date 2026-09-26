import { readFileSync } from 'node:fs';

import { hash, verify } from '@node-rs/argon2';

const commonPasswords = new Set(
  readFileSync(
    new URL('../../../../shared/src/common-passwords.txt', import.meta.url),
    'utf8',
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((password) => password.toLowerCase()),
);

const hashOptions = {
  // @node-rs/argon2 defines Argon2id as 2; its ambient const enum cannot be imported with verbatimModuleSyntax.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export type PasswordIssue = 'too_short' | 'too_long' | 'common';

export function passwordIssue(password: string): PasswordIssue | null {
  const length = Array.from(password).length;
  if (length < 10) return 'too_short';
  if (length > 256) return 'too_long';
  if (commonPasswords.has(password.trim().toLowerCase())) return 'common';
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const issue = passwordIssue(password);
  if (issue) throw new RangeError(`Password rejected: ${issue}`);
  return hash(password, hashOptions);
}

export async function verifyPassword(
  encodedHash: string,
  candidate: string,
): Promise<boolean> {
  return verify(encodedHash, candidate);
}
