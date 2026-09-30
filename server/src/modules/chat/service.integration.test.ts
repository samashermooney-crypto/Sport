import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { FakeEmailSender } from '../../integrations/email/sender';
import { PreviewPushSender } from '../../integrations/push/sender';
import { issueSession } from '../auth/sessions';

import {
  enqueueChatNotificationBatch,
  processDueChatNotificationBatches,
} from './notification-batching';
import {
  ChatAccessError,
  ChatPermissionError,
  SafeSportError,
  createConversation,
  getChatAttachmentCapabilities,
  ensureTeamConversation,
  listConversations,
  listPersonMessageHistory,
  listHouseholdMessageHistory,
  listChatMemberOptions,
  listMessages,
  moderationReports,
  sendChatMessage,
} from './service';

let database: ReturnType<typeof createDatabase>;
let withOrg: ReturnType<typeof createWithOrg>;
const orgId = randomUUID();
const ownerId = randomUUID();
const minorId = randomUUID();
const guardianId = randomUUID();
const linkOnlyId = randomUUID();
const minorNoGuardianId = randomUUID();
const linkedPersonId = randomUUID();
const unguardedPersonId = randomUUID();
const linkOnlyPersonId = randomUUID();
const householdId = randomUUID();
const foreignOrgId = randomUUID();
const foreignHouseholdId = randomUUID();
const seasonId = randomUUID();
const sportProfileId = randomUUID();
const programId = randomUUID();
const divisionId = randomUUID();
const teamId = randomUUID();
const teamSeasonId = randomUUID();
const ownerContext: OrgContext = { orgId, actor: { accountId: ownerId } };
const unauthorizedContext: OrgContext = {
  orgId,
  actor: { accountId: minorId },
};

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const [id, firstName, dateOfBirth] of [
      [ownerId, 'Owner', '1980-01-01'],
      [minorId, 'Minor', '2012-04-01'],
      [guardianId, 'Guardian', '1980-01-01'],
      [linkOnlyId, 'Linked guardian', '1980-01-01'],
      [minorNoGuardianId, 'Youth', '2013-05-01'],
    ] as const)
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [id, `${id}@example.invalid`, firstName, 'Chat', dateOfBirth],
      );
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone) VALUES ($1,$2,$3,$4,$5)',
      [orgId, `chat-${orgId.slice(0, 8)}`, 'Chat test', 'club', 'UTC'],
    );
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone) VALUES ($1,$2,$3,$4,$5)',
      [
        foreignOrgId,
        `foreign-${foreignOrgId.slice(0, 8)}`,
        'Foreign chat test',
        'club',
        'UTC',
      ],
    );
    for (const accountId of [ownerId, minorId, guardianId, minorNoGuardianId])
      await admin.query(
        'INSERT INTO org_memberships(id,org_id,account_id,status,joined_at) VALUES ($1,$2,$3,$4,now())',
        [randomUUID(), orgId, accountId, 'active'],
      );
    await admin.query(
      'INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa) VALUES ($1,$2,$3,$4,$5,false)',
      [randomUUID(), orgId, ownerId, 'owner', 'org'],
    );
    await admin.query(
      'INSERT INTO people(id,org_id,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5),($6,$2,$7,$4,$8),($9,$2,$10,$4,$11)',
      [
        linkedPersonId,
        orgId,
        'Teen',
        'Athlete',
        '2012-04-01',
        unguardedPersonId,
        'Youth',
        '2013-05-01',
        linkOnlyPersonId,
        'Linked youth',
        '2012-06-01',
      ],
    );
    await admin.query(
      'INSERT INTO person_account_links(id,org_id,person_id,account_id,relationship,verified_at) VALUES ($1,$2,$3,$4,$5,now()),($6,$2,$3,$7,$8,now()),($9,$2,$10,$11,$5,now()),($12,$2,$13,$14,$15,now())',
      [
        randomUUID(),
        orgId,
        linkedPersonId,
        minorId,
        'self',
        randomUUID(),
        guardianId,
        'guardian',
        randomUUID(),
        unguardedPersonId,
        minorNoGuardianId,
        randomUUID(),
        linkOnlyPersonId,
        linkOnlyId,
        'guardian',
      ],
    );
    await admin.query(
      'INSERT INTO households(id,org_id,name) VALUES ($1,$2,$3)',
      [householdId, orgId, 'Chat test household'],
    );
    await admin.query(
      'INSERT INTO household_members(id,org_id,household_id,person_id,role) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), orgId, householdId, linkedPersonId, 'athlete'],
    );
    await admin.query(
      'INSERT INTO households(id,org_id,name) VALUES ($1,$2,$3)',
      [foreignHouseholdId, foreignOrgId, 'Foreign household'],
    );
    await admin.query(
      'INSERT INTO seasons(id,org_id,name,starts_on,ends_on,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [seasonId, orgId, 'Fall 2026', '2026-08-01', '2026-12-01', 'active'],
    );
    await admin.query(
      'INSERT INTO sport_profiles(id,org_id,name,profile) VALUES ($1,$2,$3,$4::jsonb)',
      [sportProfileId, orgId, 'Soccer', '{}'],
    );
    await admin.query(
      'INSERT INTO programs(id,org_id,season_id,sport_profile_id,mode,name,slug,starts_on,ends_on,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        programId,
        orgId,
        seasonId,
        sportProfileId,
        'league',
        'U15 Soccer',
        `u15-${orgId.slice(0, 8)}`,
        '2026-08-01',
        '2026-12-01',
        'in_progress',
      ],
    );
    await admin.query(
      'INSERT INTO divisions(id,org_id,program_id,name,age_label) VALUES ($1,$2,$3,$4,$5)',
      [divisionId, orgId, programId, 'U15', 'U15'],
    );
    await admin.query(
      'INSERT INTO teams(id,org_id,name,sport_profile_id,age_label) VALUES ($1,$2,$3,$4,$5)',
      [teamId, orgId, 'Comets', sportProfileId, 'U15'],
    );
    await admin.query(
      'INSERT INTO team_seasons(id,org_id,team_id,program_id,division_id,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [teamSeasonId, orgId, teamId, programId, divisionId, 'active'],
    );
    await admin.query(
      'INSERT INTO roster_entries(id,org_id,team_season_id,person_id,status) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), orgId, teamSeasonId, linkedPersonId, 'active'],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => database.destroy());

describe('chat SafeSport and permission rules', () => {
  it('batches per-conversation unread fallback for ten minutes and honors locale preferences', async () => {
    const start = new Date('2026-09-27T18:00:00.000Z');
    const conversation = await createConversation(
      ownerContext,
      { kind: 'group', title: 'Team updates', accountIds: [guardianId] },
      start,
      withOrg,
    );
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query(
        'UPDATE accounts SET email_verified_at = now(), locale = $2, timezone = $3 WHERE id = $1',
        [guardianId, 'es', 'UTC'],
      );
    } finally {
      await admin.end();
    }

    for (const [index, minute] of [0, 3, 7].entries()) {
      const sentAt = new Date(start.getTime() + minute * 60_000);
      await sendChatMessage(
        ownerContext,
        conversation.id,
        { body: `Update ${String(index + 1)}`, attachments: [] },
        {
          encryption: { activeKid: 'test', keys: new Map() },
          notifications: ({ context, accountId, conversationId, messageId }) =>
            enqueueChatNotificationBatch(
              context,
              { accountId, conversationId, messageId },
              sentAt,
              withOrg,
            ),
        },
        sentAt,
        withOrg,
      );
    }

    const pending = await withOrg(ownerContext, (trx) =>
      trx
        .selectFrom('chat_notification_batches')
        .select(['id', 'message_count', 'available_at', 'status'])
        .where('org_id', '=', orgId)
        .where('conversation_id', '=', conversation.id)
        .where('recipient_account_id', '=', guardianId)
        .executeTakeFirstOrThrow(),
    );
    expect(pending).toMatchObject({ message_count: 3, status: 'pending' });
    expect(pending.available_at).toEqual(
      new Date(start.getTime() + 10 * 60_000),
    );

    const email = new FakeEmailSender();
    await expect(
      processDueChatNotificationBatches(
        orgId,
        { email, push: new PreviewPushSender(), appUrl: 'https://app.test' },
        pending.available_at,
        withOrg,
      ),
    ).resolves.toBe(1);
    expect(email.messages).toHaveLength(1);
    expect(email.messages[0]).toMatchObject({
      to: `${guardianId}@example.invalid`,
      subject: 'Chat test: tienes mensajes sin leer',
      kind: 'transactional',
    });
    expect(email.messages[0]?.text).toContain(
      'Tienes 3 mensajes sin leer en Athlentry.',
    );
    expect(email.messages[0]?.text).toContain(
      `/portal/orgs/${orgId}/notifications#preferences`,
    );
    const sent = await withOrg(ownerContext, (trx) =>
      trx
        .selectFrom('chat_notification_batches')
        .select(['status', 'email_sent_at'])
        .where('org_id', '=', orgId)
        .where('id', '=', pending.id)
        .executeTakeFirstOrThrow(),
    );
    expect(sent.status).toBe('sent');
    expect(sent.email_sent_at).toBeInstanceOf(Date);
  });

  it('skips batched push and email when the conversation was read before the window closes', async () => {
    const start = new Date('2026-09-28T18:00:00.000Z');
    const conversation = await createConversation(
      ownerContext,
      { kind: 'group', title: 'Read before send', accountIds: [guardianId] },
      start,
      withOrg,
    );
    await sendChatMessage(
      ownerContext,
      conversation.id,
      { body: 'Please review', attachments: [] },
      {
        encryption: { activeKid: 'test', keys: new Map() },
        notifications: ({ context, accountId, conversationId, messageId }) =>
          enqueueChatNotificationBatch(
            context,
            { accountId, conversationId, messageId },
            start,
            withOrg,
          ),
      },
      start,
      withOrg,
    );
    await withOrg({ orgId, actor: { accountId: guardianId } }, (trx) =>
      trx
        .updateTable('conversation_members')
        .set({ last_read_at: new Date(start.getTime() + 2 * 60_000) })
        .where('org_id', '=', orgId)
        .where('conversation_id', '=', conversation.id)
        .where('account_id', '=', guardianId)
        .execute(),
    );
    const email = new FakeEmailSender();
    await processDueChatNotificationBatches(
      orgId,
      { email, push: new PreviewPushSender(), appUrl: 'https://app.test' },
      new Date(start.getTime() + 10 * 60_000),
      withOrg,
    );
    expect(email.messages).toHaveLength(0);
    await expect(
      withOrg(ownerContext, (trx) =>
        trx
          .selectFrom('chat_notification_batches')
          .select('status')
          .where('org_id', '=', orgId)
          .where('conversation_id', '=', conversation.id)
          .where('recipient_account_id', '=', guardianId)
          .executeTakeFirstOrThrow(),
      ),
    ).resolves.toEqual({ status: 'skipped' });
  });

  it('uses enabled push before email for unread conversation fallback', async () => {
    const start = new Date('2026-09-29T02:00:00.000Z');
    const conversation = await createConversation(
      ownerContext,
      { kind: 'group', title: 'Push updates', accountIds: [guardianId] },
      start,
      withOrg,
    );
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: guardianId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        start,
      ),
    );
    await withOrg(ownerContext, async (trx) => {
      await trx
        .insertInto('communication_preferences')
        .values({
          id: randomUUID(),
          org_id: orgId,
          account_id: guardianId,
          category: 'operational',
          channel: 'push',
          enabled: true,
        })
        .execute();
      await trx
        .insertInto('communication_preferences')
        .values({
          id: randomUUID(),
          org_id: orgId,
          account_id: guardianId,
          category: 'operational',
          channel: 'email',
          enabled: false,
        })
        .execute();
      await trx
        .insertInto('device_tokens')
        .values({
          id: randomUUID(),
          account_id: guardianId,
          platform: 'webpush',
          token_or_subscription: {
            endpoint: `https://push.example.invalid/${guardianId}`,
            keys: { p256dh: 'test-public-key', auth: 'test-auth-key' },
          },
          session_id: session.id,
        })
        .execute();
    });
    await sendChatMessage(
      ownerContext,
      conversation.id,
      { body: 'Sensitive chat body is never copied to push.', attachments: [] },
      {
        encryption: { activeKid: 'test', keys: new Map() },
        notifications: ({ context, accountId, conversationId, messageId }) =>
          enqueueChatNotificationBatch(
            context,
            { accountId, conversationId, messageId },
            start,
            withOrg,
          ),
      },
      start,
      withOrg,
    );

    const email = new FakeEmailSender();
    const push = new PreviewPushSender();
    await processDueChatNotificationBatches(
      orgId,
      { email, push, appUrl: 'https://app.test' },
      new Date(start.getTime() + 10 * 60_000),
      withOrg,
    );
    expect(push.deliveries).toHaveLength(0);
    expect(email.messages).toHaveLength(0);
    const deferred = await withOrg(ownerContext, (trx) =>
      trx
        .selectFrom('chat_notification_batches')
        .select(['status', 'available_at'])
        .where('org_id', '=', orgId)
        .where('conversation_id', '=', conversation.id)
        .where('recipient_account_id', '=', guardianId)
        .executeTakeFirstOrThrow(),
    );
    expect(deferred).toEqual({
      status: 'pending',
      available_at: new Date('2026-09-29T08:00:00.000Z'),
    });
    await processDueChatNotificationBatches(
      orgId,
      { email, push, appUrl: 'https://app.test' },
      deferred.available_at,
      withOrg,
    );
    expect(push.deliveries).toHaveLength(1);
    expect(push.deliveries[0]?.message.body).toContain('1');
    expect(push.deliveries[0]?.message.body).not.toContain(
      'Sensitive chat body',
    );
    expect(email.messages).toHaveLength(0);
  });

  it('reports attachment controls only when Files permissions allow them', async () => {
    await expect(
      getChatAttachmentCapabilities(ownerContext, withOrg),
    ).resolves.toEqual({ canUpload: true, canDownload: true });
    await expect(
      getChatAttachmentCapabilities(unauthorizedContext, withOrg),
    ).resolves.toEqual({ canUpload: false, canDownload: true });
    await expect(
      getChatAttachmentCapabilities(
        { orgId, actor: { accountId: linkOnlyId } },
        withOrg,
      ),
    ).resolves.toEqual({ canUpload: false, canDownload: false });
  });

  it('attaches completed internal files and rejects a file from another tenant', async () => {
    const conversation = await createConversation(
      ownerContext,
      {
        kind: 'group',
        title: 'File sharing',
        accountIds: [guardianId, linkOnlyId],
      },
      new Date('2026-09-27T18:00:00Z'),
      withOrg,
    );
    const fileId = randomUUID();
    const foreignFileId = randomUUID();
    const expiredFileId = randomUUID();
    const addFile = async (fileOrgId: string, id: string) =>
      withOrg({ orgId: fileOrgId, actor: { accountId: ownerId } }, (trx) =>
        trx
          .insertInto('files')
          .values({
            id,
            org_id: fileOrgId,
            purpose: 'document',
            storage_key: `${fileOrgId}/${id}`,
            mime: 'application/pdf',
            bytes: 100,
            sensitivity: 'internal',
            created_by: ownerId,
            upload_state: 'complete',
            expires_at: new Date('2026-09-28T18:00:00Z'),
          })
          .execute(),
      );
    await addFile(orgId, fileId);
    await addFile(foreignOrgId, foreignFileId);
    await withOrg({ orgId, actor: { accountId: ownerId } }, (trx) =>
      trx
        .insertInto('files')
        .values({
          id: expiredFileId,
          org_id: orgId,
          purpose: 'document',
          storage_key: `${orgId}/${expiredFileId}`,
          mime: 'application/pdf',
          bytes: 100,
          sensitivity: 'internal',
          created_by: ownerId,
          upload_state: 'complete',
          expires_at: new Date('2026-09-27T18:00:00Z'),
        })
        .execute(),
    );

    await expect(
      sendChatMessage(
        ownerContext,
        conversation.id,
        { body: 'Schedule attached', attachments: [fileId] },
        {
          encryption: { activeKid: 'test', keys: new Map() },
          notifications: () => Promise.resolve(),
        },
        new Date('2026-09-27T18:01:00Z'),
        withOrg,
      ),
    ).resolves.toMatchObject({ conversationId: conversation.id });
    await expect(
      sendChatMessage(
        ownerContext,
        conversation.id,
        { body: 'Foreign attachment', attachments: [foreignFileId] },
        {
          encryption: { activeKid: 'test', keys: new Map() },
          notifications: () => Promise.resolve(),
        },
        new Date('2026-09-27T18:02:00Z'),
        withOrg,
      ),
    ).rejects.toBeInstanceOf(ChatAccessError);
    await expect(
      sendChatMessage(
        ownerContext,
        conversation.id,
        { body: 'Expired attachment', attachments: [expiredFileId] },
        {
          encryption: { activeKid: 'test', keys: new Map() },
          notifications: () => Promise.resolve(),
        },
        new Date('2026-09-27T18:03:00Z'),
        withOrg,
      ),
    ).rejects.toBeInstanceOf(ChatAccessError);
    await expect(
      listMessages(ownerContext, conversation.id, { limit: 50 }, withOrg),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          attachments: [{ fileId, mime: 'application/pdf' }],
        }),
      ],
    });
  });

  it('copies a linked guardian into an adult to minor direct conversation', async () => {
    const conversation = await createConversation(
      ownerContext,
      { kind: 'direct', accountIds: [minorId, guardianId] },
      new Date('2026-09-27T18:00:00Z'),
      withOrg,
    );
    expect(conversation.guardianCopied).toBe(true);
    const members = await withOrg(ownerContext, (trx) =>
      trx
        .selectFrom('conversation_members')
        .select('account_id')
        .where('org_id', '=', orgId)
        .where('conversation_id', '=', conversation.id)
        .execute(),
    );
    expect(members.map((member) => member.account_id)).toContain(guardianId);
  });

  it('rejects an adult to minor direct conversation without a guardian and protects moderation', async () => {
    await expect(
      createConversation(
        ownerContext,
        { kind: 'direct', accountIds: [minorNoGuardianId] },
        new Date('2026-09-27T18:00:00Z'),
        withOrg,
      ),
    ).rejects.toBeInstanceOf(SafeSportError);
    await expect(
      moderationReports(unauthorizedContext, withOrg),
    ).rejects.toBeInstanceOf(ChatPermissionError);
  });

  it('creates read-only announcement channels and copies guardians for minors', async () => {
    const conversation = await createConversation(
      ownerContext,
      { kind: 'announcement', title: 'Season update', accountIds: [minorId] },
      new Date('2026-09-27T18:00:00Z'),
      withOrg,
    );
    expect(conversation.guardianCopied).toBe(true);
    const members = await withOrg(ownerContext, (trx) =>
      trx
        .selectFrom('conversation_members')
        .select(['account_id', 'role', 'guardian_copied'])
        .where('org_id', '=', orgId)
        .where('conversation_id', '=', conversation.id)
        .execute(),
    );
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: ownerId,
          role: 'owner',
          guardian_copied: false,
        }),
        expect.objectContaining({
          account_id: minorId,
          role: 'read_only',
          guardian_copied: false,
        }),
        expect.objectContaining({
          account_id: guardianId,
          role: 'read_only',
          guardian_copied: true,
        }),
      ]),
    );
    await expect(
      sendChatMessage(
        { orgId, actor: { accountId: minorId } },
        conversation.id,
        { body: 'Can I post?', attachments: [] },
        {
          encryption: { activeKid: 'test', keys: new Map() },
          notifications: () => Promise.resolve(),
        },
        new Date('2026-09-27T18:01:00Z'),
        withOrg,
      ),
    ).rejects.toBeInstanceOf(ChatPermissionError);
  });

  it('always adds minor guardians to team chat and includes athlete accounts only when enabled', async () => {
    const now = new Date('2026-09-27T18:00:00Z');
    const closed = await ensureTeamConversation(
      ownerContext,
      teamSeasonId,
      now,
      withOrg,
    );
    expect(closed.guardianCopied).toBe(true);
    expect(closed.muted).toBe(false);
    const staffConversation = (
      await listConversations(ownerContext, withOrg)
    ).items.find((item) => item.id === closed.id);
    expect(staffConversation).toMatchObject({
      guardianCopied: true,
      muted: false,
    });
    const guardianConversation = (
      await listConversations(
        { orgId, actor: { accountId: guardianId } },
        withOrg,
      )
    ).items.find((item) => item.id === closed.id);
    expect(guardianConversation).toMatchObject({
      guardianCopied: true,
      muted: false,
    });
    let members = await withOrg(ownerContext, (trx) =>
      trx
        .selectFrom('conversation_members')
        .select(['account_id', 'guardian_copied'])
        .where('org_id', '=', orgId)
        .where('conversation_id', '=', closed.id)
        .execute(),
    );
    expect(members.map((member) => member.account_id)).toContain(guardianId);
    expect(members.map((member) => member.account_id)).not.toContain(minorId);

    await withOrg(ownerContext, (trx) =>
      trx
        .updateTable('programs')
        .set({ settings: { communications: { athleteChatEnabled: true } } })
        .where('org_id', '=', orgId)
        .where('id', '=', programId)
        .execute(),
    );
    const opened = await ensureTeamConversation(
      ownerContext,
      teamSeasonId,
      now,
      withOrg,
    );
    expect(opened.id).toBe(closed.id);
    expect(opened.muted).toBe(false);
    members = await withOrg(ownerContext, (trx) =>
      trx
        .selectFrom('conversation_members')
        .select(['account_id', 'guardian_copied'])
        .where('org_id', '=', orgId)
        .where('conversation_id', '=', closed.id)
        .execute(),
    );
    expect(members.map((member) => member.account_id)).toContain(minorId);
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: guardianId,
          guardian_copied: true,
        }),
      ]),
    );

    await withOrg(ownerContext, (trx) =>
      trx
        .updateTable('programs')
        .set({ settings: {} })
        .where('org_id', '=', orgId)
        .where('id', '=', programId)
        .execute(),
    );
    await ensureTeamConversation(ownerContext, teamSeasonId, now, withOrg);
    const revokedMinor = await withOrg(ownerContext, (trx) =>
      trx
        .selectFrom('conversation_members')
        .select('revoked_at')
        .where('org_id', '=', orgId)
        .where('conversation_id', '=', closed.id)
        .where('account_id', '=', minorId)
        .executeTakeFirstOrThrow(),
    );
    expect(revokedMinor.revoked_at).not.toBeNull();
    await expect(
      listMessages(
        { orgId, actor: { accountId: minorId } },
        closed.id,
        { limit: 50 },
        withOrg,
      ),
    ).rejects.toBeInstanceOf(ChatAccessError);
  });

  it('limits channel member search to authorized accounts in the current org', async () => {
    const result = await listChatMemberOptions(ownerContext, '', withOrg);
    expect(result.items.map((item) => item.accountId).sort()).toEqual(
      [ownerId, minorId, guardianId, linkOnlyId, minorNoGuardianId].sort(),
    );
    await expect(
      listChatMemberOptions(unauthorizedContext, '', withOrg),
    ).rejects.toBeInstanceOf(ChatPermissionError);
  });

  it('scopes household message history to authorized staff and the current organization', async () => {
    await expect(
      listHouseholdMessageHistory(ownerContext, householdId, withOrg),
    ).resolves.toEqual({ items: [] });
    await expect(
      listHouseholdMessageHistory(unauthorizedContext, householdId, withOrg),
    ).rejects.toBeInstanceOf(ChatPermissionError);
    await expect(
      listHouseholdMessageHistory(ownerContext, randomUUID(), withOrg),
    ).rejects.toBeInstanceOf(ChatAccessError);
    await expect(
      listHouseholdMessageHistory(ownerContext, foreignHouseholdId, withOrg),
    ).rejects.toBeInstanceOf(ChatAccessError);
  });

  it('hides person and household message history from nonmembers with 404 semantics', async () => {
    const nonmemberContext = {
      orgId: foreignOrgId,
      actor: { accountId: ownerId },
    };
    await expect(
      listPersonMessageHistory(nonmemberContext, linkedPersonId, withOrg),
    ).rejects.toBeInstanceOf(ChatAccessError);
    await expect(
      listHouseholdMessageHistory(
        nonmemberContext,
        foreignHouseholdId,
        withOrg,
      ),
    ).rejects.toBeInstanceOf(ChatAccessError);
    await expect(
      listConversations(nonmemberContext, withOrg),
    ).rejects.toBeInstanceOf(ChatAccessError);
    await expect(
      moderationReports(nonmemberContext, withOrg),
    ).rejects.toBeInstanceOf(ChatAccessError);
  });
});
