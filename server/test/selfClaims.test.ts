import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { FakeEmailSender } from '../src/integrations/email/sender';
import { createSelfClaimsRepository } from '../src/modules/people/selfClaims';

import { createTestFactories } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('requires a staff-issued adult, email-bound claim and rechecks changed profile email', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  const foreign = await factories.actor();
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', staff.orgId)
      .where('account_id', '=', staff.accountId)
      .execute();
  });
  const adultId = await factories.person(staff, { dateOfBirth: '1980-01-01' });
  const childId = await factories.person(staff);
  const email = `claim-${randomUUID()}@example.invalid`;
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('people')
      .set({ email })
      .where('org_id', '=', staff.orgId)
      .where('id', '=', adultId)
      .execute();
  });
  const accountId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email,
      first_name: 'Adult',
      last_name: 'Account',
      date_of_birth: '1980-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  const claims = createSelfClaimsRepository(database);
  const sender = new FakeEmailSender();
  await expect(
    claims.invite(
      staff.orgId,
      staff.accountId,
      childId,
      email,
      sender,
      'https://athlentry.test',
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    claims.invite(
      staff.orgId,
      staff.accountId,
      adultId,
      `other-${randomUUID()}@example.invalid`,
      sender,
      'https://athlentry.test',
    ),
  ).rejects.toMatchObject({ status: 409 });
  await claims.invite(
    staff.orgId,
    staff.accountId,
    adultId,
    email,
    sender,
    'https://athlentry.test',
  );
  const token =
    sender.messages[0]?.text.match(
      /claim-person\/[0-9a-f-]+\/([A-Za-z0-9_-]{43})/,
    )?.[1] ?? '';
  await expect(
    claims.accept(foreign.orgId, accountId, token),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    claims.accept(staff.orgId, staff.accountId, token),
  ).rejects.toMatchObject({ status: 404 });
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('people')
      .set({ email: 'changed@example.invalid' })
      .where('org_id', '=', staff.orgId)
      .where('id', '=', adultId)
      .execute();
  });
  await expect(
    claims.accept(staff.orgId, accountId, token),
  ).rejects.toMatchObject({ status: 409 });
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('people')
      .set({ email })
      .where('org_id', '=', staff.orgId)
      .where('id', '=', adultId)
      .execute();
  });
  const accepted = await claims.accept(staff.orgId, accountId, token);
  expect(accepted.personId).toBe(adultId);
  await expect(
    claims.accept(staff.orgId, accountId, token),
  ).rejects.toMatchObject({ status: 404 });
  const linked = await factories.scoped(staff, (trx) =>
    trx
      .selectFrom('person_account_links')
      .select('account_id')
      .where('org_id', '=', staff.orgId)
      .where('person_id', '=', adultId)
      .where('relationship', '=', 'self')
      .executeTakeFirstOrThrow(),
  );
  expect(linked.account_id).toBe(accountId);
});

it('writes an administrator-supplied email to a blank adult profile only at claim redemption', async () => {
  const factories = createTestFactories(database);
  const staff = await factories.actor();
  await factories.scoped(staff, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', staff.orgId)
      .where('account_id', '=', staff.accountId)
      .execute();
  });
  const adultId = await factories.person(staff, { dateOfBirth: '1980-01-01' });
  const email = `blank-${randomUUID()}@example.invalid`;
  const accountId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email,
      first_name: 'Adult',
      last_name: 'Claimant',
      date_of_birth: '1980-01-01',
      email_verified_at: new Date(),
    })
    .execute();
  const sender = new FakeEmailSender();
  const claims = createSelfClaimsRepository(database);
  await claims.invite(
    staff.orgId,
    staff.accountId,
    adultId,
    email,
    sender,
    'https://athlentry.test',
  );
  const before = await factories.scoped(staff, (trx) =>
    trx
      .selectFrom('people')
      .select('email')
      .where('id', '=', adultId)
      .executeTakeFirstOrThrow(),
  );
  expect(before.email).toBeNull();
  const token =
    sender.messages[0]?.text.match(
      /claim-person\/[0-9a-f-]+\/([A-Za-z0-9_-]{43})/,
    )?.[1] ?? '';
  await claims.accept(staff.orgId, accountId, token);
  const after = await factories.scoped(staff, (trx) =>
    trx
      .selectFrom('people')
      .select(['email', 'version'])
      .where('id', '=', adultId)
      .executeTakeFirstOrThrow(),
  );
  expect(after.email).toBe(email);
  expect(after.version).toBe(2);
});
