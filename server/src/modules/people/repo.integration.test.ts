import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';

import { createPeopleRepository, PeopleError } from './repo';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('scopes people, versions edits, archives instead of deleting, and audits writes', async () => {
  const withOrg = createWithOrg(database);
  async function actor() {
    const orgId = newId();
    const accountId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `people-${randomUUID()}@example.invalid`,
        first_name: 'Test',
        last_name: 'Owner',
        date_of_birth: '1980-01-01',
      })
      .execute();
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: `people-${randomUUID().slice(0, 12)}`,
        name: 'People Test',
        kind: 'club',
        timezone: 'UTC',
      })
      .execute();
    const context = { orgId, actor: { accountId }, accountId };
    await withOrg(context, async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: accountId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: accountId,
          role: 'owner',
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
    });
    return context;
  }
  const owner = await actor();
  const outsider = await actor();
  const people = createPeopleRepository(database);
  const created = await people.create(owner.orgId, owner.accountId, {
    firstName: 'Alex',
    lastName: 'Rivera',
    preferredName: null,
    dateOfBirth: '2011-04-12',
    gender: 'female',
    email: 'alex@example.invalid',
    phoneE164: null,
    mediaConsent: 'unknown',
  });
  expect(created.version).toBe(1);
  expect(
    (
      await people.list(owner.orgId, owner.accountId, {
        q: 'Rivera',
        status: 'active',
        limit: 30,
      })
    ).items.map((person) => person.id),
  ).toEqual([created.id]);
  await expect(
    people.get(owner.orgId, outsider.accountId, created.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    people.get(outsider.orgId, outsider.accountId, created.id),
  ).rejects.toMatchObject({ status: 404 });
  const updated = await people.update(
    owner.orgId,
    owner.accountId,
    created.id,
    {
      expectedVersion: 1,
      preferredName: 'Lex',
    },
  );
  expect(updated).toMatchObject({
    preferredName: 'Lex',
    gender: 'female',
    email: 'alex@example.invalid',
    version: 2,
  });
  await expect(
    people.update(owner.orgId, owner.accountId, created.id, {
      expectedVersion: 1,
      firstName: 'Stale',
    }),
  ).rejects.toBeInstanceOf(PeopleError);
  const archived = await people.archive(
    owner.orgId,
    owner.accountId,
    created.id,
    2,
  );
  expect(archived).toMatchObject({ status: 'archived', version: 3 });
  expect(
    (
      await people.list(owner.orgId, owner.accountId, {
        status: 'active',
        limit: 30,
      })
    ).items,
  ).toEqual([]);
  expect(
    (
      await people.list(owner.orgId, owner.accountId, {
        status: 'archived',
        limit: 30,
      })
    ).items,
  ).toHaveLength(1);
  const restored = await people.restore(
    owner.orgId,
    owner.accountId,
    created.id,
    3,
  );
  expect(restored).toMatchObject({ status: 'active', version: 4 });
  const evidence = await withOrg(owner, (trx) =>
    trx
      .selectFrom('audit_log')
      .select('action')
      .where('org_id', '=', owner.orgId)
      .where('entity_id', '=', created.id)
      .orderBy('created_at')
      .execute(),
  );
  expect(evidence.map((event) => event.action)).toEqual([
    'person.created',
    'person.updated',
    'person.archived',
    'person.restored',
  ]);
});
