import { randomBytes } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import { FakeEmailSender } from '../../integrations/email/sender';
import { encryptRestricted, parseEncryptionKeys } from '../../lib/crypto';

import { hashPassword } from './password';
import {
  completeMfaChallenge,
  InvalidCredentialsError,
  requestMagicLink,
  signInWithMagicLink,
  signInWithPassword,
} from './signin';
import type { SignInDependencies } from './signin';
import { decodeBase32, newTotpSecret, totpCode } from './totp';

const now = new Date('2026-09-26T18:00:00Z');
const email = new FakeEmailSender();
const accountId = newId();
const privilegedAccountId = newId();
const orgId = newId();
const secretBase32 = newTotpSecret();
const encryption = parseEncryptionKeys(
  JSON.stringify({ k1: randomBytes(32).toString('base64') }),
  'k1',
);
let database: Kysely<DB>;
let dependencies: SignInDependencies;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  dependencies = {
    database,
    email,
    encryption,
    appUrl: 'http://127.0.0.1:5173',
    clock: () => now,
  };
  const passwordHash = await hashPassword('four safe winter paddles 92');
  await database
    .insertInto('accounts')
    .values([
      {
        id: accountId,
        email: 'member@example.invalid',
        first_name: 'Member',
        last_name: 'Example',
        date_of_birth: '2000-01-01',
        password_hash: passwordHash,
        email_verified_at: now,
      },
      {
        id: privilegedAccountId,
        email: 'owner@example.invalid',
        first_name: 'Owner',
        last_name: 'Example',
        date_of_birth: '2000-01-01',
        password_hash: passwordHash,
        email_verified_at: now,
      },
    ])
    .execute();
  await database
    .insertInto('mfa_factors')
    .values({
      id: newId(),
      account_id: privilegedAccountId,
      type: 'totp',
      secret_enc: encryptRestricted(Buffer.from(secretBase32), encryption),
      confirmed_at: now,
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: 'signin-test-org',
      name: 'Sign In Test Org',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  await createWithOrg(database)(
    { orgId, actor: { accountId: privilegedAccountId } },
    async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: privilegedAccountId,
          status: 'active',
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: privilegedAccountId,
          role: 'owner',
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
    },
  );
  const indexed = await database
    .selectFrom('accounts')
    .select('linked_org_ids')
    .where('id', '=', privilegedAccountId)
    .executeTakeFirstOrThrow();
  expect(indexed.linked_org_ids).toContain(orgId);
});

afterAll(async () => {
  await database.destroy();
});

describe('sign-in entry points', () => {
  it('rejects invalid credentials and issues a session for a verified member', async () => {
    await expect(
      signInWithPassword(dependencies, {
        email: 'member@example.invalid',
        password: 'incorrect password',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    const result = await signInWithPassword(dependencies, {
      email: 'member@example.invalid',
      password: 'four safe winter paddles 92',
    });
    expect(result.status).toBe('session');
    if (result.status !== 'session') throw new Error('Expected session');
    expect(result.session.token).toHaveLength(43);
  });

  it('keeps magic-link requests generic and consumes the link once', async () => {
    const generic = await requestMagicLink(
      dependencies,
      'nobody@example.invalid',
    );
    expect(generic).toContain('If this address has an account');
    expect(email.messages).toHaveLength(0);
    expect(await requestMagicLink(dependencies, 'member@example.invalid')).toBe(
      generic,
    );
    const raw = email.messages[0]?.text.match(
      /\/magic\/([A-Za-z0-9_-]{43})/,
    )?.[1];
    if (!raw) throw new Error('Magic link missing');
    expect((await signInWithMagicLink(dependencies, raw)).status).toBe(
      'session',
    );
    await expect(signInWithMagicLink(dependencies, raw)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('requires a one-use TOTP challenge for an active owner role', async () => {
    const result = await signInWithPassword(dependencies, {
      email: 'owner@example.invalid',
      password: 'four safe winter paddles 92',
    });
    expect(result.status).toBe('mfa_required');
    if (result.status !== 'mfa_required')
      throw new Error('Expected MFA challenge');
    const step = Math.floor(now.getTime() / 30_000);
    const code = totpCode(decodeBase32(secretBase32), step);
    const session = await completeMfaChallenge(
      dependencies,
      result.challengeToken,
      code,
      'totp',
    );
    expect(session.idleExpiresAt.getTime() - now.getTime()).toBe(
      12 * 60 * 60_000,
    );
    await expect(
      completeMfaChallenge(dependencies, result.challengeToken, code, 'totp'),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});
