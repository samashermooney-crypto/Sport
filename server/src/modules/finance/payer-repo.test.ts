import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';

import { PostgresPayerProfileRepository } from './payer-repo.js';

let database: Kysely<DB>;
let repository: PostgresPayerProfileRepository;
let accountId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  repository = new PostgresPayerProfileRepository(database);
  accountId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `payer-${randomUUID()}@example.invalid`,
      first_name: 'Payer',
      last_name: 'Test',
      date_of_birth: '1990-01-01',
    })
    .execute();
});

afterAll(async () => {
  await database.destroy();
});

describe('Postgres payer profile repository', () => {
  it('reserves once under concurrency and fences an uncertain creation', async () => {
    const results = await Promise.all([
      repository.reserve(accountId),
      repository.reserve(accountId),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      'busy',
      'reserved',
    ]);
    expect(await repository.load(accountId)).toBeNull();
  });

  it('stores one Customer and returns it on later reservations', async () => {
    await repository.save(accountId, 'cus_test_repo_1');
    expect(await repository.load(accountId)).toBe('cus_test_repo_1');
    expect(await repository.findAccountByCustomer('cus_test_repo_1')).toBe(
      accountId,
    );
    expect(await repository.reserve(accountId)).toEqual({
      kind: 'existing',
      customerId: 'cus_test_repo_1',
    });
    await expect(repository.save(accountId, 'cus_second')).rejects.toThrow(
      'completed',
    );
  });
});
