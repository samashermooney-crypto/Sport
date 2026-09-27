import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/kysely';
import { createWithOrg } from '../src/db/withOrg';
import { FakeEmailSender } from '../src/integrations/email/sender';
import {
  acceptOrgInvitation,
  createOrgInvitation,
  listOrgStaff,
  resendOrgInvitation,
  revokeOrgInvitation,
} from '../src/modules/orgs/invitations';

import { createTestFactories } from './factories';

const now = new Date('2026-09-26T18:00:00Z');
const email = `invited-${randomUUID()}@example.invalid`;
const sender = new FakeEmailSender();
let database: ReturnType<typeof createDatabase>;
let orgId = '';
let ownerId = '';
let recipientId = '';
let otherOrgId = '';

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const factory = createTestFactories(database);
  const actor = await factory.actor();
  orgId = actor.orgId;
  ownerId = actor.accountId;
  otherOrgId = (await factory.actor()).orgId;
  await createWithOrg(database)(actor, (trx) =>
    trx
      .updateTable('role_assignments')
      .set({ pending_mfa: false })
      .where('account_id', '=', ownerId)
      .execute()
      .then(() => undefined),
  );
  recipientId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: recipientId,
      email,
      first_name: 'Invited',
      last_name: 'Admin',
      date_of_birth: '1990-01-01',
      email_verified_at: now,
    })
    .execute();
});

afterAll(async () => {
  await database.destroy();
});

describe('organization invitations', () => {
  it('replays idempotently, hides other scopes and grants pending roles once', async () => {
    const invitation = {
      email,
      roles: ['admin', 'registrar'] as Array<'admin' | 'registrar'>,
      scopeType: 'org' as const,
      scopeId: null,
    };
    const key = newId();
    const dependencies = {
      database,
      email: sender,
      appUrl: 'https://127.0.0.1:5173',
    };
    await expect(
      createOrgInvitation(dependencies, {
        orgId: otherOrgId,
        actorId: ownerId,
        invitation,
        idempotencyKey: newId(),
        now,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const sent = await createOrgInvitation(dependencies, {
      orgId,
      actorId: ownerId,
      invitation,
      idempotencyKey: key,
      now,
    });
    expect(sent.email).toBe(email);
    expect(sender.messages).toHaveLength(1);
    const replay = await createOrgInvitation(dependencies, {
      orgId,
      actorId: ownerId,
      invitation,
      idempotencyKey: key,
      now,
    });
    expect(replay).toEqual(sent);
    expect(sender.messages).toHaveLength(1);
    await expect(
      createOrgInvitation(dependencies, {
        orgId,
        actorId: ownerId,
        invitation: { ...invitation, roles: ['reporter'] },
        idempotencyKey: key,
        now,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const token = /\/invitations\/[0-9a-f-]+\/([A-Za-z0-9_-]{43})/.exec(
      sender.messages[0]?.text ?? '',
    )?.[1];
    expect(token).toBeTruthy();
    if (!token) throw new Error('Preview invitation token missing');
    await expect(
      acceptOrgInvitation(database, {
        orgId: otherOrgId,
        accountId: recipientId,
        token,
        now,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const accepted = await acceptOrgInvitation(database, {
      orgId,
      accountId: recipientId,
      token,
      now,
    });
    expect(accepted).toMatchObject({
      orgId,
      accountId: recipientId,
      roles: ['admin', 'registrar'],
      pendingMfa: true,
    });
    await expect(
      acceptOrgInvitation(database, {
        orgId,
        accountId: recipientId,
        token,
        now,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const roles = await createWithOrg(database)(
      { orgId, actor: { accountId: ownerId } },
      (trx) =>
        trx
          .selectFrom('role_assignments')
          .select(['role', 'pending_mfa'])
          .where('account_id', '=', recipientId)
          .orderBy('role')
          .execute(),
    );
    expect(roles).toEqual([
      { role: 'admin', pending_mfa: true },
      { role: 'registrar', pending_mfa: false },
    ]);
  });
  it('lists, resends and revokes invitations without exposing other organizations', async () => {
    const inviteEmail = `resend-${randomUUID()}@example.invalid`;
    const dependencies = {
      database,
      email: sender,
      appUrl: 'https://127.0.0.1:5173',
    };
    const original = await createOrgInvitation(dependencies, {
      orgId,
      actorId: ownerId,
      invitation: {
        email: inviteEmail,
        roles: ['reporter'],
        scopeType: 'org',
        scopeId: null,
      },
      idempotencyKey: newId(),
      now,
    });
    const listed = await listOrgStaff(database, {
      orgId,
      actorId: ownerId,
      now,
    });
    expect(listed.invitations).toContainEqual(
      expect.objectContaining({ id: original.id, email: inviteEmail }),
    );
    await expect(
      listOrgStaff(database, { orgId: otherOrgId, actorId: ownerId, now }),
    ).rejects.toMatchObject({ status: 404 });
    const resent = await resendOrgInvitation(dependencies, {
      orgId,
      actorId: ownerId,
      invitationId: original.id,
      idempotencyKey: newId(),
      now: new Date(now.getTime() + 60_000),
    });
    expect(resent.id).not.toBe(original.id);
    expect(sender.messages.at(-1)?.to).toBe(inviteEmail);
    await expect(
      revokeOrgInvitation(database, {
        orgId: otherOrgId,
        actorId: ownerId,
        invitationId: resent.id,
        now,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await revokeOrgInvitation(database, {
      orgId,
      actorId: ownerId,
      invitationId: resent.id,
      now,
    });
    const remaining = await listOrgStaff(database, {
      orgId,
      actorId: ownerId,
      now,
    });
    expect(
      remaining.invitations.find((item) => item.email === inviteEmail),
    ).toBeUndefined();
  });
});
