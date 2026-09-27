import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { FakeEmailSender } from '../../integrations/email/sender';

import {
  changePassword,
  confirmEmailChange,
  requestAccountDeletion,
  requestEmailChange,
  requestPasswordReset,
  resetPassword,
} from './credentials';
import type { CredentialsDependencies } from './credentials';
import { hashPassword, verifyPassword } from './password';
import { issueSession, resolveSession, stepUpSession } from './sessions';

const now = new Date('2026-09-26T18:00:00Z');
const email = new FakeEmailSender();
let database: Kysely<DB>;
let dependencies: CredentialsDependencies;

async function createAccount(address: string): Promise<string> {
  const id = newId();
  await database
    .insertInto('accounts')
    .values({
      id,
      email: address,
      first_name: 'Credentials',
      last_name: 'Test',
      date_of_birth: '2000-01-01',
      password_hash: await hashPassword('original cedar blanket 67'),
      email_verified_at: now,
    })
    .execute();
  return id;
}

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  dependencies = {
    database,
    email,
    appUrl: 'http://127.0.0.1:5173',
    clock: () => now,
  };
});

afterAll(async () => {
  await database.destroy();
});

describe('credential and privacy requests', () => {
  it('resets passwords with one-use links and revokes active sessions', async () => {
    const accountId = await createAccount('reset@example.invalid');
    await database
      .updateTable('accounts')
      .set({ locale: 'es' })
      .where('id', '=', accountId)
      .execute();
    const issued = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        now,
      ),
    );
    const generic = await requestPasswordReset(
      dependencies,
      'absent@example.invalid',
    );
    expect(email.messages).toHaveLength(0);
    expect(
      await requestPasswordReset(dependencies, 'reset@example.invalid'),
    ).toBe(generic);
    expect(email.messages[0]?.subject).toBe('Restablezca su contraseña');
    expect(email.messages[0]?.html).toContain('<html lang="es">');
    const raw = email.messages[0]?.text.match(
      /\/reset\/([A-Za-z0-9_-]{43})/,
    )?.[1];
    if (!raw) throw new Error('Reset token missing');
    expect(
      await resetPassword(dependencies, raw, 'new amber hillside phrase 41'),
    ).toBe(true);
    expect(email.messages.at(-1)?.subject).toBe(
      'Se restableció su contraseña de Athlentry',
    );
    expect(email.messages.at(-1)?.html).toContain('<html lang="es">');
    expect(
      await resetPassword(dependencies, raw, 'new amber hillside phrase 41'),
    ).toBe(false);
    expect(
      await database
        .transaction()
        .execute((trx) => resolveSession(trx, issued.token, now)),
    ).toBeNull();
    const account = await database
      .selectFrom('accounts')
      .select('password_hash')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(
      await verifyPassword(
        account.password_hash ?? '',
        'new amber hillside phrase 41',
      ),
    ).toBe(true);
  });

  it('changes password, verifies a new email, and opens a deletion review request', async () => {
    const accountId = await createAccount('change@example.invalid');
    const first = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        now,
      ),
    );
    const second = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        now,
      ),
    );
    let active = await database
      .transaction()
      .execute((trx) => resolveSession(trx, first.token, now));
    if (!active) throw new Error('Current session missing');
    await changePassword(
      dependencies,
      active,
      'original cedar blanket 67',
      'new silver harbor phrase 84',
    );
    expect(
      await database
        .transaction()
        .execute((trx) => resolveSession(trx, second.token, now)),
    ).toBeNull();
    expect(
      await database
        .transaction()
        .execute((trx) => resolveSession(trx, first.token, now)),
    ).not.toBeNull();

    await expect(
      requestEmailChange(dependencies, active, 'new@example.invalid'),
    ).rejects.toThrow('Recent');
    expect(
      await database
        .transaction()
        .execute((trx) => stepUpSession(trx, first.id, accountId, now)),
    ).toBe(true);
    active = await database
      .transaction()
      .execute((trx) => resolveSession(trx, first.token, now));
    if (!active) throw new Error('Current session missing');
    await requestEmailChange(dependencies, active, 'new@example.invalid');
    const message = email.messages.find(
      (entry) => entry.to === 'new@example.invalid',
    );
    const raw = message?.text.match(
      /\/verify-email-change\/([A-Za-z0-9_-]{43})/,
    )?.[1];
    if (!raw) throw new Error('Email-change token missing');
    expect(await confirmEmailChange(dependencies, raw)).toBe(true);
    expect(await confirmEmailChange(dependencies, raw)).toBe(false);
    expect(
      await database
        .transaction()
        .execute((trx) => resolveSession(trx, first.token, now)),
    ).toBeNull();
    const account = await database
      .selectFrom('accounts')
      .select('email')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(account.email).toBe('new@example.invalid');

    const third = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        now,
      ),
    );
    expect(
      await database
        .transaction()
        .execute((trx) => stepUpSession(trx, third.id, accountId, now)),
    ).toBe(true);
    const reviewed = await database
      .transaction()
      .execute((trx) => resolveSession(trx, third.token, now));
    if (!reviewed) throw new Error('Current session missing');
    const requestId = await requestAccountDeletion(
      dependencies,
      reviewed,
      'Please review my account',
    );
    expect(await requestAccountDeletion(dependencies, reviewed)).toBe(
      requestId,
    );
    const request = await database
      .selectFrom('privacy_requests')
      .select(['status', 'kind'])
      .where('id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(request).toEqual({ status: 'pending', kind: 'account_deletion' });
  });
});
