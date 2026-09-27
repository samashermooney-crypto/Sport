import { newId } from '@shared/ids';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import { createWithOrg } from '../src/db/withOrg';
import { listMyOrganizations } from '../src/modules/orgs/mine';
import { getOrgWorkspace } from '../src/modules/orgs/workspace';

import { createTestFactories } from './factories';

let database: ReturnType<typeof createDatabase>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('lists only active organizations linked to the signed-in account', async () => {
  const factory = createTestFactories(database);
  const account = await factory.actor();
  const other = await factory.actor();
  const foreign = await factory.actor();
  await createWithOrg(database)(other, (trx) =>
    trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: other.orgId,
        account_id: account.accountId,
        status: 'active',
        joined_at: new Date(),
      })
      .execute()
      .then(() => undefined),
  );
  const listed = await listMyOrganizations(database, account.accountId);
  expect(listed.map((org) => org.id).sort()).toEqual(
    [account.orgId, other.orgId].sort(),
  );
  expect(listed.some((org) => org.id === foreign.orgId)).toBe(false);
  expect(
    (await getOrgWorkspace(database, other.orgId, account.accountId)).canManage,
  ).toBe(false);
  await expect(
    getOrgWorkspace(database, foreign.orgId, account.accountId),
  ).rejects.toMatchObject({ status: 404 });
  await createWithOrg(database)(account, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', account.orgId)
      .where('account_id', '=', account.accountId)
      .execute()
      .then(() => undefined),
  );
  expect(
    (await getOrgWorkspace(database, account.orgId, account.accountId))
      .canManage,
  ).toBe(true);
  await createWithOrg(database)(other, (trx) =>
    trx
      .updateTable('org_memberships')
      .set({ status: 'suspended' })
      .where('org_id', '=', other.orgId)
      .where('account_id', '=', account.accountId)
      .execute()
      .then(() => undefined),
  );
  expect(
    (await listMyOrganizations(database, account.accountId)).map(
      (org) => org.id,
    ),
  ).toEqual([account.orgId]);
  await expect(
    getOrgWorkspace(database, other.orgId, account.accountId),
  ).rejects.toMatchObject({ status: 404 });
});
