import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import type { DB } from '../src/db/types';
import { createPeopleRepository } from '../src/modules/people/repo';

import { createTestFactories } from './factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('requires consent and a completed image owned by the person, then detaches on revocation', async () => {
  const factories = createTestFactories(database);
  const actor = await factories.actor();
  await factories.scoped(actor, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .where('account_id', '=', actor.accountId)
      .execute()
      .then(() => undefined),
  );
  const personId = await factories.person(actor);
  const people = createPeopleRepository(database);
  const fileId = newId();
  await factories.row(actor, 'files', {
    id: fileId,
    org_id: actor.orgId,
    purpose: 'image',
    owner_type: 'person',
    owner_id: personId,
    storage_key: `people-photo-${randomUUID()}`,
    mime: 'image/jpeg',
    bytes: 123,
    sensitivity: 'sensitive',
    created_by: actor.accountId,
    upload_state: 'complete',
  });
  await expect(
    people.setPhoto(actor.orgId, actor.accountId, personId, {
      expectedVersion: 1,
      fileId,
    }),
  ).rejects.toMatchObject({ status: 409 });
  const granted = await people.update(actor.orgId, actor.accountId, personId, {
    expectedVersion: 1,
    mediaConsent: 'granted',
  });
  expect(granted.photoFileId).toBeNull();
  const foreignFileId = newId();
  await factories.row(actor, 'files', {
    id: foreignFileId,
    org_id: actor.orgId,
    purpose: 'image',
    owner_type: 'person',
    owner_id: await factories.person(actor),
    storage_key: `people-photo-${randomUUID()}`,
    mime: 'image/jpeg',
    bytes: 123,
    sensitivity: 'sensitive',
    created_by: actor.accountId,
    upload_state: 'complete',
  });
  await expect(
    people.setPhoto(actor.orgId, actor.accountId, personId, {
      expectedVersion: granted.version,
      fileId: foreignFileId,
    }),
  ).rejects.toMatchObject({ status: 400 });
  const attached = await people.setPhoto(
    actor.orgId,
    actor.accountId,
    personId,
    {
      expectedVersion: granted.version,
      fileId,
    },
  );
  expect(attached.photoFileId).toBe(fileId);
  const revoked = await people.update(actor.orgId, actor.accountId, personId, {
    expectedVersion: attached.version,
    mediaConsent: 'denied',
  });
  expect(revoked.photoFileId).toBeNull();
  const stored = await factories.scoped(actor, (trx) =>
    trx
      .selectFrom('people')
      .select('photo_file_id')
      .where('id', '=', personId)
      .executeTakeFirstOrThrow(),
  );
  expect(stored.photo_file_id).toBeNull();
  const retiredFile = await factories.scoped(actor, (trx) =>
    trx
      .selectFrom('files')
      .select('deleted_at')
      .where('id', '=', fileId)
      .executeTakeFirstOrThrow(),
  );
  expect(retiredFile.deleted_at).not.toBeNull();
});
