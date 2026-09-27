import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import { createWithOrg } from '../src/db/withOrg';
import { getOrgProfile, updateOrgProfile } from '../src/modules/orgs/profile';

import { createTestFactories } from './factories';

let database: ReturnType<typeof createDatabase>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('versions owner profile edits and accepts only a completed same-org logo', async () => {
  const factory = createTestFactories(database);
  const owner = await factory.actor();
  const foreign = await factory.actor();
  await createWithOrg(database)(owner, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', owner.orgId)
      .where('account_id', '=', owner.accountId)
      .execute()
      .then(() => undefined),
  );
  const now = new Date();
  const first = await getOrgProfile(database, owner.orgId, owner.accountId);
  expect(first.brand.primaryColor).toBe('#3A67B2');
  await expect(
    getOrgProfile(database, foreign.orgId, owner.accountId),
  ).rejects.toMatchObject({ status: 404 });
  const foreignLogo = newId();
  await createWithOrg(database)(foreign, (trx) =>
    trx
      .insertInto('files')
      .values({
        id: foreignLogo,
        org_id: foreign.orgId,
        purpose: 'image',
        owner_type: 'organization',
        owner_id: foreign.orgId,
        storage_key: `test/${randomUUID()}.png`,
        mime: 'image/png',
        bytes: 10,
        created_by: foreign.accountId,
        upload_state: 'complete',
      })
      .execute()
      .then(() => undefined),
  );
  const changes = {
    name: 'Updated Youth Club',
    legalName: null,
    timezone: 'America/Chicago',
    address: null,
    phone: '+13125550123',
    email: 'hello@example.invalid',
    websiteUrl: 'https://example.invalid',
    defaultLocale: 'es' as const,
    brand: { primaryColor: '#3A67B2', accentColor: '#2F5590' },
    logoFileId: foreignLogo,
    nonprofit: true,
    expectedVersion: first.version,
  };
  await expect(
    updateOrgProfile(database, {
      orgId: owner.orgId,
      actorId: owner.accountId,
      changes,
      now,
    }),
  ).rejects.toMatchObject({ status: 404 });
  const logo = newId();
  await createWithOrg(database)(owner, (trx) =>
    trx
      .insertInto('files')
      .values({
        id: logo,
        org_id: owner.orgId,
        purpose: 'image',
        owner_type: 'organization',
        owner_id: owner.orgId,
        storage_key: `test/${randomUUID()}.png`,
        mime: 'image/png',
        bytes: 10,
        created_by: owner.accountId,
        upload_state: 'complete',
      })
      .execute()
      .then(() => undefined),
  );
  const saved = await updateOrgProfile(database, {
    orgId: owner.orgId,
    actorId: owner.accountId,
    changes: { ...changes, logoFileId: logo },
    now,
  });
  expect(saved).toMatchObject({
    name: 'Updated Youth Club',
    logoFileId: logo,
    defaultLocale: 'es',
    version: first.version + 1,
  });
  await expect(
    updateOrgProfile(database, {
      orgId: owner.orgId,
      actorId: owner.accountId,
      changes: { ...changes, logoFileId: logo },
      now,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    updateOrgProfile(database, {
      orgId: owner.orgId,
      actorId: foreign.accountId,
      changes: { ...changes, logoFileId: logo, expectedVersion: saved.version },
      now,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    updateOrgProfile(database, {
      orgId: owner.orgId,
      actorId: owner.accountId,
      changes: {
        ...changes,
        brand: { primaryColor: '#FFFFFF', accentColor: '#2F5590' },
        logoFileId: logo,
        expectedVersion: saved.version,
      },
      now,
    }),
  ).rejects.toThrow();
});
