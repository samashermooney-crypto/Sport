import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import {
  ChatPermissionError,
  SafeSportError,
  createConversation,
  moderationReports,
} from './service';

let database: ReturnType<typeof createDatabase>;
let withOrg: ReturnType<typeof createWithOrg>;
const orgId = randomUUID();
const ownerId = randomUUID();
const minorId = randomUUID();
const guardianId = randomUUID();
const minorNoGuardianId = randomUUID();
const linkedPersonId = randomUUID();
const unguardedPersonId = randomUUID();
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
      'INSERT INTO people(id,org_id,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5),($6,$2,$7,$4,$8)',
      [
        linkedPersonId,
        orgId,
        'Teen',
        'Athlete',
        '2012-04-01',
        unguardedPersonId,
        'Youth',
        '2013-05-01',
      ],
    );
    await admin.query(
      'INSERT INTO person_account_links(id,org_id,person_id,account_id,relationship) VALUES ($1,$2,$3,$4,$5),($6,$2,$3,$7,$8),($9,$2,$10,$11,$5)',
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
      ],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => database.destroy());

describe('chat SafeSport and permission rules', () => {
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
});
