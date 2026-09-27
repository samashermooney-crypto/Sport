import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import { createWithOrg } from '../src/db/withOrg';
import { issueSession, resolveSession } from '../src/modules/auth/sessions';
import {
  setOrgMemberStatus,
  setScopedRole,
} from '../src/modules/orgs/memberRoles';

import { createTestFactories } from './factories';

const now = new Date('2026-09-26T18:00:00Z');
let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

async function activeOwner() {
  const actor = await createTestFactories(database).actor();
  await createWithOrg(database)(actor, async (trx) => {
    await trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('org_id', '=', actor.orgId)
      .where('account_id', '=', actor.accountId)
      .execute();
  });
  return actor;
}

async function addMember(
  orgId: string,
  actorId: string,
  role: 'owner' | 'registrar',
) {
  const id = newId();
  await database
    .insertInto('accounts')
    .values({
      id,
      email: `status-${randomUUID()}@example.invalid`,
      first_name: 'Status',
      last_name: 'Member',
      date_of_birth: '1990-01-01',
      email_verified_at: now,
    })
    .execute();
  await createWithOrg(database)(
    { orgId, actor: { accountId: actorId } },
    async (trx) => {
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
    },
  );
  return id;
}

describe('organization membership status', () => {
  it('grants and revokes a role only within a valid tenant scope', async () => {
    const actor = await activeOwner();
    const other = await activeOwner();
    const program = await createTestFactories(database).program(actor);
    const foreign = await createTestFactories(database).program(other);
    const member = await addMember(actor.orgId, actor.accountId, 'registrar');
    const base = {
      orgId: actor.orgId,
      actorId: actor.accountId,
      targetId: member,
      now,
    };
    await expect(
      setScopedRole(database, {
        ...base,
        changes: {
          role: 'scheduler',
          scopeType: 'program',
          scopeId: foreign.programId,
          enabled: true,
          expectedVersion: 1,
        },
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await setScopedRole(database, {
        ...base,
        changes: {
          role: 'scheduler',
          scopeType: 'program',
          scopeId: program.programId,
          enabled: true,
          expectedVersion: 1,
        },
      }),
    ).toMatchObject({ version: 2, pendingMfa: false });
    await expect(
      setScopedRole(database, {
        ...base,
        changes: {
          role: 'scheduler',
          scopeType: 'program',
          scopeId: program.programId,
          enabled: false,
          expectedVersion: 1,
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await setScopedRole(database, {
        ...base,
        changes: {
          role: 'scheduler',
          scopeType: 'program',
          scopeId: program.programId,
          enabled: false,
          expectedVersion: 2,
        },
      }),
    ).toMatchObject({ version: 3 });
    const rows = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('role_assignments')
        .select('revoked_at')
        .where('account_id', '=', member)
        .where('role', '=', 'scheduler')
        .execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });
  it('suspends, reactivates and removes without deleting records or retaining sessions', async () => {
    const actor = await activeOwner();
    const other = await activeOwner();
    const member = await addMember(actor.orgId, actor.accountId, 'registrar');
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: member,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        now,
      ),
    );
    await expect(
      setOrgMemberStatus(database, {
        orgId: other.orgId,
        actorId: actor.accountId,
        targetId: member,
        changes: { status: 'suspended', expectedVersion: 1 },
        now,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await setOrgMemberStatus(database, {
        orgId: actor.orgId,
        actorId: actor.accountId,
        targetId: member,
        changes: { status: 'suspended', expectedVersion: 1 },
        now,
      }),
    ).toMatchObject({ status: 'suspended', version: 2 });
    expect(
      await database
        .transaction()
        .execute((trx) => resolveSession(trx, session.token, now)),
    ).toBeNull();
    await expect(
      setOrgMemberStatus(database, {
        orgId: actor.orgId,
        actorId: actor.accountId,
        targetId: member,
        changes: { status: 'active', expectedVersion: 1 },
        now,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await setOrgMemberStatus(database, {
        orgId: actor.orgId,
        actorId: actor.accountId,
        targetId: member,
        changes: { status: 'active', expectedVersion: 2 },
        now,
      }),
    ).toMatchObject({ status: 'active', version: 3 });
    expect(
      await setOrgMemberStatus(database, {
        orgId: actor.orgId,
        actorId: actor.accountId,
        targetId: member,
        changes: { status: 'removed', expectedVersion: 3 },
        now,
      }),
    ).toMatchObject({ status: 'removed', version: 4 });
    const records = await createWithOrg(database)(actor, async (trx) =>
      Promise.all([
        trx
          .selectFrom('org_memberships')
          .select('status')
          .where('account_id', '=', member)
          .executeTakeFirstOrThrow(),
        trx
          .selectFrom('role_assignments')
          .select('revoked_at')
          .where('account_id', '=', member)
          .executeTakeFirstOrThrow(),
      ]),
    );
    expect(records[0].status).toBe('removed');
    expect(records[1].revoked_at).toBeInstanceOf(Date);
    await expect(
      setOrgMemberStatus(database, {
        orgId: actor.orgId,
        actorId: actor.accountId,
        targetId: member,
        changes: { status: 'active', expectedVersion: 4 },
        now,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('serializes concurrent owner suspensions and keeps one active owner', async () => {
    const actor = await activeOwner();
    const second = await addMember(actor.orgId, actor.accountId, 'owner');
    const attempts = await Promise.allSettled(
      [actor.accountId, second].map((id) =>
        setOrgMemberStatus(database, {
          orgId: actor.orgId,
          actorId: id,
          targetId: id,
          changes: { status: 'suspended', expectedVersion: 1 },
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
    const active = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('org_memberships')
        .select('account_id')
        .where('org_id', '=', actor.orgId)
        .where('status', '=', 'active')
        .execute(),
    );
    expect(active).toHaveLength(1);
  });
});
