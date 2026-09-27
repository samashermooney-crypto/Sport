import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import { createWithOrg } from '../src/db/withOrg';
import { issueSession, resolveSession } from '../src/modules/auth/sessions';
import {
  OrgMemberRolesError,
  setOrgMemberRoles,
} from '../src/modules/orgs/memberRoles';

import { createTestFactories } from './factories';

const now = new Date('2026-09-26T18:00:00Z');
let database: ReturnType<typeof createDatabase>;
let orgId = '';
let ownerA = '';
let ownerB = '';
let registrar = '';
let outsideOrgId = '';

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const factory = createTestFactories(database);
  const actor = await factory.actor();
  orgId = actor.orgId;
  ownerA = actor.accountId;
  const outsider = await factory.actor();
  outsideOrgId = outsider.orgId;
  ownerB = newId();
  registrar = newId();
  for (const [id, role] of [
    [ownerB, 'owner'],
    [registrar, 'registrar'],
  ] as const) {
    await database
      .insertInto('accounts')
      .values({
        id,
        email: `roles-${randomUUID()}@example.invalid`,
        first_name: 'Roles',
        last_name: 'Test',
        date_of_birth: '1990-01-01',
        email_verified_at: now,
      })
      .execute();
    await createWithOrg(database)(actor, async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: id,
          status: 'active',
          joined_at: now,
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: id,
          role,
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
    });
  }
  await createWithOrg(database)(actor, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('account_id', '=', ownerA)
      .execute()
      .then(() => undefined),
  );
});

afterAll(async () => {
  await database.destroy();
});

describe('organization role changes', () => {
  it('versions, audits and revokes a changed member while hiding other tenants', async () => {
    const issued = await database
      .transaction()
      .execute((trx) =>
        issueSession(
          trx,
          {
            accountId: registrar,
            kind: 'cookie',
            client: 'web',
            privileged: false,
          },
          now,
        ),
      );
    await expect(
      setOrgMemberRoles(database, {
        orgId: outsideOrgId,
        actorId: ownerA,
        targetId: registrar,
        changes: { roles: ['registrar', 'admin'], expectedVersion: 1 },
        now,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const changed = await setOrgMemberRoles(database, {
      orgId,
      actorId: ownerA,
      targetId: registrar,
      changes: { roles: ['registrar', 'admin'], expectedVersion: 1 },
      now,
    });
    expect(changed).toMatchObject({
      accountId: registrar,
      roles: ['registrar', 'admin'],
      pendingMfa: true,
      version: 2,
    });
    expect(
      await database
        .transaction()
        .execute((trx) => resolveSession(trx, issued.token, now)),
    ).toBeNull();
    await expect(
      setOrgMemberRoles(database, {
        orgId,
        actorId: ownerA,
        targetId: registrar,
        changes: { roles: ['reporter'], expectedVersion: 1 },
        now,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const audit = await createWithOrg(database)(
      { orgId, actor: { accountId: ownerA } },
      (trx) =>
        trx
          .selectFrom('audit_log')
          .select('changes')
          .where('action', '=', 'membership.roles_changed')
          .executeTakeFirstOrThrow(),
    );
    expect(audit.changes).toMatchObject({
      before: ['registrar'],
      after: ['admin', 'registrar'],
    });
  });

  it('serializes two owner demotions and preserves an active owner', async () => {
    const attempts = await Promise.allSettled(
      [ownerA, ownerB].map((id) =>
        setOrgMemberRoles(database, {
          orgId,
          actorId: id,
          targetId: id,
          changes: { roles: ['reporter'], expectedVersion: 1 },
          now,
        }),
      ),
    );
    expect(
      attempts.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected')
      expect(rejected.reason).toBeInstanceOf(OrgMemberRolesError);
    const owners = await createWithOrg(database)(
      { orgId, actor: { accountId: ownerA } },
      (trx) =>
        trx
          .selectFrom('role_assignments')
          .select('account_id')
          .where('role', '=', 'owner')
          .where('revoked_at', 'is', null)
          .where('pending_mfa', '=', false)
          .execute(),
    );
    expect(owners).toHaveLength(1);
  });
});
