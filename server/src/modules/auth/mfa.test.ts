import { randomBytes } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { encryptRestricted, parseEncryptionKeys } from '../../lib/crypto';

import { verifyAndConsumeTotp } from './mfa';
import { decodeBase32, newTotpSecret, totpCode } from './totp';

const accountId = newId();
const secretBase32 = newTotpSecret();
const secret = decodeBase32(secretBase32);
const encryption = parseEncryptionKeys(
  JSON.stringify({ k1: randomBytes(32).toString('base64') }),
  'k1',
);
let database: Kysely<DB>;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: 'mfa-test@example.invalid',
      first_name: 'Mfa',
      last_name: 'Test',
      date_of_birth: '2000-01-01',
    })
    .execute();
  await database
    .insertInto('mfa_factors')
    .values({
      id: newId(),
      account_id: accountId,
      type: 'totp',
      secret_enc: encryptRestricted(Buffer.from(secretBase32), encryption),
    })
    .execute();
});

afterAll(async () => {
  await database.destroy();
});

describe('MFA replay protection', () => {
  it('confirms enrollment and consumes a code only once under concurrency', async () => {
    const firstStep = 2_000_000;
    const firstCode = totpCode(secret, firstStep);
    expect(
      await database
        .transaction()
        .execute((trx) =>
          verifyAndConsumeTotp(
            trx,
            accountId,
            firstCode,
            firstStep * 30_000,
            encryption,
            true,
          ),
        ),
    ).toBe(true);
    expect(
      await database
        .transaction()
        .execute((trx) =>
          verifyAndConsumeTotp(
            trx,
            accountId,
            firstCode,
            firstStep * 30_000,
            encryption,
          ),
        ),
    ).toBe(false);

    const nextStep = firstStep + 1;
    const nextCode = totpCode(secret, nextStep);
    const results = await Promise.all([
      database
        .transaction()
        .execute((trx) =>
          verifyAndConsumeTotp(
            trx,
            accountId,
            nextCode,
            nextStep * 30_000,
            encryption,
          ),
        ),
      database
        .transaction()
        .execute((trx) =>
          verifyAndConsumeTotp(
            trx,
            accountId,
            nextCode,
            nextStep * 30_000,
            encryption,
          ),
        ),
    ]);
    expect(results.sort()).toEqual([false, true]);
    const events = await database
      .selectFrom('security_events')
      .select('action')
      .where('account_id', '=', accountId)
      .execute();
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.action === 'mfa.secret_read')).toBe(
      true,
    );
  });
});
