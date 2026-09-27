import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import { createWithOrg } from '../src/db/withOrg';
import { FakeEmailSender } from '../src/integrations/email/sender';
import {
  acceptOwnershipTransfer,
  requestOwnershipTransfer,
} from '../src/modules/orgs/ownershipTransfer';

import { createTestFactories } from './factories';

const now = new Date('2026-09-26T18:00:00Z');
let database: ReturnType<typeof createDatabase>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

it('requires recipient MFA and consent, then transfers owner role once', async () => {
  const actor = await createTestFactories(database).actor();
  await createWithOrg(database)(actor, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .where('account_id', '=', actor.accountId)
      .execute()
      .then(() => undefined),
  );
  const targetId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: targetId,
      email: `transfer-${randomUUID()}@example.invalid`,
      first_name: 'New',
      last_name: 'Owner',
      date_of_birth: '1990-01-01',
      email_verified_at: now,
    })
    .execute();
  await createWithOrg(database)(actor, (trx) =>
    trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: actor.orgId,
        account_id: targetId,
        status: 'active',
        joined_at: now,
      })
      .execute()
      .then(() => undefined),
  );
  const email = new FakeEmailSender();
  const request = {
    orgId: actor.orgId,
    actorId: actor.accountId,
    recipientAccountId: targetId,
    expectedVersion: 1,
    now,
  };
  const dependency = { database, email, appUrl: 'http://localhost:5173' };
  const result = await requestOwnershipTransfer(dependency, request);
  expect(result.recipientAccountId).toBe(targetId);
  expect(email.messages).toHaveLength(1);
  const token = email.messages[0]?.text.match(
    /\/ownership-transfer\/[^/]+\/([A-Za-z0-9_-]{43})/,
  )?.[1];
  expect(token).toBeDefined();
  const accept = {
    orgId: actor.orgId,
    recipientId: targetId,
    token: String(token),
    now,
  };
  await expect(
    acceptOwnershipTransfer(database, {
      ...accept,
      recipientId: actor.accountId,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(acceptOwnershipTransfer(database, accept)).rejects.toMatchObject(
    { status: 403 },
  );
  await expect(
    acceptOwnershipTransfer(database, {
      ...accept,
      now: new Date(now.getTime() + 25 * 60 * 60 * 1_000),
    }),
  ).rejects.toMatchObject({ status: 404 });
  await database
    .insertInto('mfa_factors')
    .values({
      id: newId(),
      account_id: targetId,
      type: 'totp',
      secret_enc: Buffer.alloc(32),
      confirmed_at: now,
    })
    .execute();
  expect(await acceptOwnershipTransfer(database, accept)).toMatchObject({
    previousOwnerId: actor.accountId,
    ownerId: targetId,
  });
  await expect(acceptOwnershipTransfer(database, accept)).rejects.toMatchObject(
    { status: 404 },
  );
  const owners = await createWithOrg(database)(actor, (trx) =>
    trx
      .selectFrom('role_assignments')
      .select(['account_id', 'revoked_at'])
      .where('org_id', '=', actor.orgId)
      .where('role', '=', 'owner')
      .execute(),
  );
  expect(
    owners.find((row) => row.account_id === actor.accountId)?.revoked_at,
  ).not.toBeNull();
  expect(
    owners.find((row) => row.account_id === targetId)?.revoked_at,
  ).toBeNull();
});
