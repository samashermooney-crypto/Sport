import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';

import { consumeRecoveryCode, generateRecoveryCodes } from './recovery';

const accountId = newId();
const now = new Date('2026-09-26T18:00:00Z');
let database: Kysely<DB>;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: 'recovery-test@example.invalid',
      first_name: 'Recovery',
      last_name: 'Test',
      date_of_birth: '2000-01-01',
    })
    .execute();
});

afterAll(async () => {
  await database.destroy();
});

describe('single-use MFA recovery', () => {
  it('shows ten codes once, stores only hashes, and invalidates regenerated codes', async () => {
    const codes = await database
      .transaction()
      .execute((trx) => generateRecoveryCodes(trx, accountId));
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    const stored = await database
      .selectFrom('mfa_recovery_codes')
      .select('code_hash')
      .where('account_id', '=', accountId)
      .execute();
    expect(stored).toHaveLength(10);
    expect(
      stored.some((row) => row.code_hash.includes(Buffer.from(codes[0] ?? ''))),
    ).toBe(false);
    const first = codes[0];
    if (!first) throw new Error('Recovery code missing');
    expect(
      await database
        .transaction()
        .execute((trx) => consumeRecoveryCode(trx, accountId, first, now)),
    ).toBe(true);
    expect(
      await database
        .transaction()
        .execute((trx) => consumeRecoveryCode(trx, accountId, first, now)),
    ).toBe(false);
    await database
      .transaction()
      .execute((trx) => generateRecoveryCodes(trx, accountId));
    const second = codes[1];
    if (!second) throw new Error('Recovery code missing');
    expect(
      await database
        .transaction()
        .execute((trx) => consumeRecoveryCode(trx, accountId, second, now)),
    ).toBe(false);
  });
});
