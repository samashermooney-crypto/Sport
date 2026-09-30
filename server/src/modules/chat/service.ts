import { randomUUID } from 'node:crypto';

import { ageOnDate } from '@shared/dates';
import { sql } from 'kysely';

import type { Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { encryptRestricted } from '../../lib/crypto';
import type { EncryptionKeys } from '../../lib/crypto';
import { decodeCursor, pageFromRows } from '../../lib/pagination';
import { appendAuditEvent } from '../audit/service';
import { evaluateSafeSport } from '../safety/safesport';
import type { ConversationMember as SafeSportMember } from '../safety/safesport';

import { chatMessageSchema, chatMessageListSchema } from './schema';

export class ChatAccessError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
}
export class ChatPermissionError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
}
export class SafeSportError extends Error {
  readonly status = 409;
  readonly code = 'SAFESPORT_GUARDIAN_REQUIRED';
}
class ChatConflictError extends Error {
  readonly status = 409;
  readonly code = 'CONFLICT';
}
class ChatIntegrationUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'SERVICE_UNAVAILABLE';
}

export type ChatNotification = (input: {
  context: OrgContext;
  accountId: string;
  conversationId: string;
  messageId: string;
}) => Promise<void>;

export type ChatDependencies = {
  encryption: EncryptionKeys;
  notifications?: ChatNotification;
  now?: () => Date;
};

async function activeOrgRoles(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<string[]> {
  const assignments = await trx
    .selectFrom('role_assignments')
    .select('role')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('scope_type', '=', 'org')
    .where('revoked_at', 'is', null)
    .where('pending_mfa', '=', false)
    .execute();
  return assignments.map((assignment) => assignment.role);
}

async function requireActiveOrgActor(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<void> {
  const member = await trx
    .selectFrom('org_memberships')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  const personLink = await trx
    .selectFrom('person_account_links')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!member && !personLink)
    throw new ChatAccessError('Conversation not found');
}

async function requireModerationRole(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<void> {
  await requireActiveOrgActor(trx, context);
  const roles = await activeOrgRoles(trx, context);
  if (!roles.some((role) => ['owner', 'admin', 'compliance'].includes(role)))
    throw new ChatPermissionError('Chat moderation access is required');
}

async function requireConversationMember(
  trx: OrgTransaction,
  context: OrgContext,
  conversationId: string,
) {
  const row = await trx
    .selectFrom('conversation_members as member')
    .innerJoin('conversations as conversation', (join) =>
      join
        .onRef('conversation.id', '=', 'member.conversation_id')
        .onRef('conversation.org_id', '=', 'member.org_id'),
    )
    .select([
      'member.role',
      'member.last_read_at',
      'member.muted',
      'conversation.kind',
      'conversation.team_season_id',
      'conversation.created_by',
      'conversation.archived_at',
    ])
    .where('member.org_id', '=', context.orgId)
    .where('member.account_id', '=', context.actor.accountId)
    .where('member.conversation_id', '=', conversationId)
    .where('member.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row || row.archived_at)
    throw new ChatAccessError('Conversation not found');
  return row;
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function dateOnly(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : value.slice(0, 10);
}

type GuardianGraph = {
  members: SafeSportMember[];
  guardianLinks: Record<string, readonly string[]>;
};

async function safeSportGraph(
  trx: OrgTransaction,
  orgId: string,
  accountIds: readonly string[],
  extraMinorPeople: readonly { id: string; dateOfBirth: string }[] = [],
  now = new Date(),
): Promise<GuardianGraph> {
  const uniqueAccounts = [...new Set(accountIds)];
  const accounts = uniqueAccounts.length
    ? await trx
        .selectFrom('accounts')
        .select(['id', 'date_of_birth'])
        .where('id', 'in', uniqueAccounts)
        .where('status', '=', 'active')
        .execute()
    : [];
  const accountIdSet = new Set(accounts.map((account) => account.id));
  const links = uniqueAccounts.length
    ? await trx
        .selectFrom('person_account_links')
        .select(['person_id', 'account_id', 'relationship'])
        .where('org_id', '=', orgId)
        .where('account_id', 'in', uniqueAccounts)
        .where('revoked_at', 'is', null)
        .execute()
    : [];
  const allPeopleIds = [
    ...new Set([
      ...links.map((link) => link.person_id),
      ...extraMinorPeople.map((person) => person.id),
    ]),
  ];
  const selfLinks = allPeopleIds.length
    ? await trx
        .selectFrom('person_account_links')
        .select(['person_id', 'account_id'])
        .where('org_id', '=', orgId)
        .where('person_id', 'in', allPeopleIds)
        .where('relationship', '=', 'self')
        .where('revoked_at', 'is', null)
        .execute()
    : [];
  const childAccountByPerson = new Map(
    selfLinks.map((link) => [link.person_id, link.account_id]),
  );
  const guardianRows = allPeopleIds.length
    ? await trx
        .selectFrom('person_account_links')
        .select(['person_id', 'account_id'])
        .where('org_id', '=', orgId)
        .where('person_id', 'in', allPeopleIds)
        .where('relationship', '=', 'guardian')
        .where('revoked_at', 'is', null)
        .execute()
    : [];
  const guardianLinks: Record<string, string[]> = {};
  const guardianOf = new Map<string, string[]>();
  for (const row of guardianRows) {
    const childAccount = childAccountByPerson.get(row.person_id);
    if (childAccount) {
      (guardianLinks[childAccount] ??= []).push(row.account_id);
      const children = guardianOf.get(row.account_id) ?? [];
      children.push(childAccount);
      guardianOf.set(row.account_id, children);
    }
  }
  const staffLinks = uniqueAccounts.length
    ? await trx
        .selectFrom('team_staff as staff')
        .innerJoin('person_account_links as link', (join) =>
          join
            .onRef('link.person_id', '=', 'staff.person_id')
            .onRef('link.org_id', '=', 'staff.org_id'),
        )
        .select('link.account_id')
        .where('staff.org_id', '=', orgId)
        .where('staff.status', '=', 'active')
        .where('link.relationship', '=', 'self')
        .where('link.revoked_at', 'is', null)
        .where('link.account_id', 'in', uniqueAccounts)
        .execute()
    : [];
  const officialLinks = uniqueAccounts.length
    ? await trx
        .selectFrom('official_assignments as assignment')
        .innerJoin('person_account_links as link', (join) =>
          join
            .onRef('link.person_id', '=', 'assignment.person_id')
            .onRef('link.org_id', '=', 'assignment.org_id'),
        )
        .select('link.account_id')
        .where('assignment.org_id', '=', orgId)
        .where('assignment.status', 'not in', ['canceled', 'declined'])
        .where('link.relationship', '=', 'self')
        .where('link.revoked_at', 'is', null)
        .where('link.account_id', 'in', uniqueAccounts)
        .execute()
    : [];
  const adultRoleAssignments = uniqueAccounts.length
    ? await trx
        .selectFrom('role_assignments')
        .select(['account_id', 'role'])
        .where('org_id', '=', orgId)
        .where('account_id', 'in', uniqueAccounts)
        .where('scope_type', '=', 'org')
        .where('revoked_at', 'is', null)
        .where('pending_mfa', '=', false)
        .execute()
    : [];
  const roleByAccount = new Map<string, SafeSportMember['adultRole']>();
  for (const assignment of adultRoleAssignments) {
    if (
      ['owner', 'admin', 'communications', 'director', 'compliance'].includes(
        assignment.role,
      )
    )
      roleByAccount.set(assignment.account_id, 'staff');
  }
  for (const link of staffLinks) roleByAccount.set(link.account_id, 'coach');
  for (const link of officialLinks)
    roleByAccount.set(link.account_id, 'official');

  const members: SafeSportMember[] = accounts.map((account) => ({
    accountId: account.id,
    age: ageOnDate(dateOnly(account.date_of_birth), utcDate(now)),
    adultRole: roleByAccount.get(account.id) ?? null,
    guardianOf: guardianOf.get(account.id) ?? [],
  }));
  for (const person of extraMinorPeople) {
    const linkedAccount = childAccountByPerson.get(person.id);
    if (linkedAccount && accountIdSet.has(linkedAccount)) continue;
    const personKey = `person:${person.id}`;
    members.push({
      accountId: personKey,
      age: ageOnDate(person.dateOfBirth, utcDate(now)),
      adultRole: null,
      guardianOf: [],
    });
    guardianLinks[personKey] = guardianRows
      .filter((row) => row.person_id === person.id)
      .map((row) => row.account_id);
  }
  return { members, guardianLinks };
}

async function validateAccountTargets(
  trx: OrgTransaction,
  orgId: string,
  accountIds: readonly string[],
): Promise<void> {
  if (!accountIds.length) return;
  const [memberships, links] = await Promise.all([
    trx
      .selectFrom('org_memberships')
      .select('account_id')
      .where('org_id', '=', orgId)
      .where('account_id', 'in', [...accountIds])
      .where('status', '=', 'active')
      .execute(),
    trx
      .selectFrom('person_account_links')
      .select('account_id')
      .where('org_id', '=', orgId)
      .where('account_id', 'in', [...accountIds])
      .where('revoked_at', 'is', null)
      .execute(),
  ]);
  const allowed = new Set(
    [...memberships, ...links].map((row) => row.account_id),
  );
  if (accountIds.some((accountId) => !allowed.has(accountId)))
    throw new ChatAccessError(
      'One or more conversation members are not in this organization',
    );
}

async function writeConversationMembers(
  trx: OrgTransaction,
  orgId: string,
  conversationId: string,
  accountIds: readonly string[],
  guardianIds: ReadonlySet<string>,
  ownerId: string,
) {
  for (const accountId of accountIds) {
    await sql`INSERT INTO conversation_members(id, org_id, conversation_id, account_id, role, guardian_copied) VALUES (${randomUUID()}, ${orgId}, ${conversationId}, ${accountId}, ${accountId === ownerId ? 'owner' : 'member'}, ${guardianIds.has(accountId)}) ON CONFLICT (org_id, conversation_id, account_id) DO UPDATE SET role = CASE WHEN conversation_members.role = 'owner' THEN 'owner' ELSE EXCLUDED.role END, guardian_copied = conversation_members.guardian_copied OR EXCLUDED.guardian_copied, revoked_at = NULL`.execute(
      trx,
    );
  }
}

async function synchronizeConversationMembers(
  trx: OrgTransaction,
  context: OrgContext,
  conversationId: string,
  accountIds: readonly string[],
  guardianIds: ReadonlySet<string>,
  ownerId: string,
  now: Date,
  created: boolean,
  kind: 'team' | 'team_staff',
  teamSeasonId: string,
) {
  const current = await trx
    .selectFrom('conversation_members')
    .select('account_id')
    .where('org_id', '=', context.orgId)
    .where('conversation_id', '=', conversationId)
    .where('revoked_at', 'is', null)
    .execute();
  const currentIds = new Set(current.map((row) => row.account_id));
  const desiredIds = new Set(accountIds);
  const removed = [...currentIds].filter((id) => !desiredIds.has(id));
  await writeConversationMembers(
    trx,
    context.orgId,
    conversationId,
    accountIds,
    guardianIds,
    ownerId,
  );
  if (removed.length)
    await trx
      .updateTable('conversation_members')
      .set({ revoked_at: now })
      .where('org_id', '=', context.orgId)
      .where('conversation_id', '=', conversationId)
      .where('account_id', 'in', removed)
      .where('revoked_at', 'is', null)
      .execute();
  const added = [...desiredIds].filter((id) => !currentIds.has(id));
  if (created || added.length || removed.length)
    await appendAuditEvent(trx, context, {
      action: created
        ? 'chat.conversation.create'
        : 'chat.conversation.members.sync',
      entityType: 'conversation',
      entityId: conversationId,
      changes: {
        kind: { tier: 'internal', after: kind },
        team_season_id: { tier: 'internal', after: teamSeasonId },
        members: {
          tier: 'internal',
          before: current.length,
          after: desiredIds.size,
        },
        members_added: { tier: 'internal', after: added.length },
        members_revoked: { tier: 'internal', after: removed.length },
        guardians_copied: { tier: 'internal', after: guardianIds.size },
      },
    });
}

async function enforceSafeSport(
  trx: OrgTransaction,
  orgId: string,
  kind: 'message' | 'direct' | 'team',
  senderId: string,
  accountIds: readonly string[],
  now: Date,
  extraMinorPeople: readonly { id: string; dateOfBirth: string }[] = [],
  smsRecipientIds: readonly string[] = [],
) {
  const graph = await safeSportGraph(
    trx,
    orgId,
    accountIds,
    extraMinorPeople,
    now,
  );
  const result = evaluateSafeSport({
    kind,
    senderAccountId: senderId,
    members: graph.members,
    guardianLinks: graph.guardianLinks,
    smsRecipientIds,
  });
  if (!result.allowed)
    throw new SafeSportError(
      'A guardian must be included in this conversation',
    );
  return {
    result,
    pseudoMinorIds: new Set(
      extraMinorPeople.map((person) => `person:${person.id}`),
    ),
  };
}

export async function createConversation(
  context: OrgContext,
  input: {
    kind: 'direct' | 'group' | 'announcement' | 'team' | 'team_staff';
    teamSeasonId?: string | null;
    title?: string | null;
    accountIds: readonly string[];
  },
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireActiveOrgActor(trx, context);
    const accountIds = [
      ...new Set([context.actor.accountId, ...input.accountIds]),
    ];
    await validateAccountTargets(trx, context.orgId, accountIds);
    const roles = await activeOrgRoles(trx, context);
    const isStaff = roles.some((role) =>
      ['owner', 'admin', 'communications', 'director'].includes(role),
    );
    if ((input.kind === 'group' || input.kind === 'announcement') && !isStaff)
      throw new ChatPermissionError(
        'Only authorized organization staff can create this conversation',
      );
    if (
      (input.kind === 'team' || input.kind === 'team_staff') &&
      !input.teamSeasonId
    )
      throw new RangeError('Team conversations require a team season');
    if (input.kind === 'team')
      throw new RangeError(
        'Team conversations are created from the active team roster',
      );
    if (input.kind === 'direct' && accountIds.length < 2)
      throw new RangeError('Direct conversation requires another member');
    if (
      (input.kind === 'group' || input.kind === 'announcement') &&
      accountIds.length < 2
    )
      throw new RangeError('Group conversations require at least two members');
    if (input.kind === 'team_staff') {
      const teamSeasonId = input.teamSeasonId;
      if (!teamSeasonId)
        throw new RangeError('Team conversations require a team season');
      const staff = await trx
        .selectFrom('team_staff')
        .select('person_id')
        .where('org_id', '=', context.orgId)
        .where('team_season_id', '=', teamSeasonId)
        .where('status', '=', 'active')
        .execute();
      const selfLinks = staff.length
        ? await trx
            .selectFrom('person_account_links')
            .select('account_id')
            .where('org_id', '=', context.orgId)
            .where(
              'person_id',
              'in',
              staff.map((row) => row.person_id),
            )
            .where('relationship', '=', 'self')
            .where('revoked_at', 'is', null)
            .execute()
        : [];
      if (
        !isStaff &&
        !selfLinks.some((row) => row.account_id === context.actor.accountId)
      )
        throw new ChatPermissionError(
          'Only team staff can create team conversations',
        );
    }
    const conversationId = randomUUID();
    const safeKind =
      input.kind === 'direct'
        ? 'direct'
        : input.kind === 'team_staff'
          ? 'team'
          : 'message';
    const safeResult = await enforceSafeSport(
      trx,
      context.orgId,
      safeKind,
      context.actor.accountId,
      accountIds,
      now,
    );
    const guardianIds = new Set(safeResult.result.guardianAdditions);
    const finalAccounts = [
      ...new Set([...accountIds, ...safeResult.result.guardianAdditions]),
    ];
    await validateAccountTargets(trx, context.orgId, finalAccounts);
    const row = await trx
      .insertInto('conversations')
      .values({
        id: conversationId,
        org_id: context.orgId,
        kind: input.kind,
        team_season_id: input.teamSeasonId ?? null,
        title: input.title ?? null,
        created_by: context.actor.accountId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeConversationMembers(
      trx,
      context.orgId,
      conversationId,
      finalAccounts,
      guardianIds,
      context.actor.accountId,
    );
    if (input.kind === 'announcement')
      await trx
        .updateTable('conversation_members')
        .set({ role: 'read_only' })
        .where('org_id', '=', context.orgId)
        .where('conversation_id', '=', conversationId)
        .where('account_id', '!=', context.actor.accountId)
        .execute();
    await appendAuditEvent(trx, context, {
      action: 'chat.conversation.create',
      entityType: 'conversation',
      entityId: conversationId,
      changes: {
        kind: { tier: 'internal', after: input.kind },
        members: { tier: 'internal', after: finalAccounts.length },
        guardians_copied: { tier: 'internal', after: guardianIds.size },
      },
    });
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      teamSeasonId: row.team_season_id,
      guardianCopied: safeResult.result.guardianCopied,
      muted: false,
      unreadCount: 0,
      lastMessageAt: null,
    };
  });
}

export async function ensureTeamConversation(
  context: OrgContext,
  teamSeasonId: string,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireActiveOrgActor(trx, context);
    const season = await trx
      .selectFrom('team_seasons as season')
      .innerJoin('programs as program', (join) =>
        join
          .onRef('program.id', '=', 'season.program_id')
          .onRef('program.org_id', '=', 'season.org_id'),
      )
      .select([
        'season.id',
        'season.team_id',
        'season.program_id',
        'program.settings',
      ])
      .where('season.org_id', '=', context.orgId)
      .where('season.id', '=', teamSeasonId)
      .executeTakeFirst();
    if (!season) throw new ChatAccessError('Team conversation not found');
    const programSettings =
      season.settings &&
      typeof season.settings === 'object' &&
      !Array.isArray(season.settings)
        ? (season.settings as Record<string, unknown>)
        : {};
    const communicationsSettings = programSettings.communications;
    const athleteChatEnabled =
      communicationsSettings !== null &&
      typeof communicationsSettings === 'object' &&
      !Array.isArray(communicationsSettings) &&
      (communicationsSettings as Record<string, unknown>).athleteChatEnabled ===
        true;
    const [roster, staff, existing] = await Promise.all([
      trx
        .selectFrom('roster_entries')
        .innerJoin('people', (join) =>
          join
            .onRef('people.id', '=', 'roster_entries.person_id')
            .onRef('people.org_id', '=', 'roster_entries.org_id'),
        )
        .select(['people.id', 'people.date_of_birth'])
        .where('roster_entries.org_id', '=', context.orgId)
        .where('roster_entries.team_season_id', '=', teamSeasonId)
        .where('roster_entries.status', 'in', [
          'active',
          'injured',
          'suspended',
        ])
        .execute(),
      trx
        .selectFrom('team_staff')
        .select('person_id')
        .where('org_id', '=', context.orgId)
        .where('team_season_id', '=', teamSeasonId)
        .where('status', '=', 'active')
        .execute(),
      trx
        .selectFrom('conversations')
        .selectAll()
        .where('org_id', '=', context.orgId)
        .where('kind', '=', 'team')
        .where('team_season_id', '=', teamSeasonId)
        .where('archived_at', 'is', null)
        .executeTakeFirst(),
    ]);
    const athleteIds = roster.map((row) => row.id);
    const personIds = [
      ...new Set([...athleteIds, ...staff.map((row) => row.person_id)]),
    ];
    const selfLinks = personIds.length
      ? await trx
          .selectFrom('person_account_links')
          .select(['person_id', 'account_id'])
          .where('org_id', '=', context.orgId)
          .where('person_id', 'in', personIds)
          .where('relationship', '=', 'self')
          .where('revoked_at', 'is', null)
          .execute()
      : [];
    const rosterAgeById = new Map(
      roster.map((row) => [
        row.id,
        ageOnDate(dateOnly(row.date_of_birth), utcDate(now)),
      ]),
    );
    const staffAccountIds = new Set(
      selfLinks
        .filter((link) =>
          staff.some((member) => member.person_id === link.person_id),
        )
        .map((link) => link.account_id),
    );
    const athleteAccountIds = new Set(
      athleteChatEnabled
        ? selfLinks
            .filter((link) => (rosterAgeById.get(link.person_id) ?? 18) >= 13)
            .map((link) => link.account_id)
        : [],
    );
    const memberIds = [...new Set([...staffAccountIds, ...athleteAccountIds])];
    if (!memberIds.includes(context.actor.accountId))
      await validateAccountTargets(trx, context.orgId, [
        context.actor.accountId,
      ]);
    const guardianActor = await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('person_id', 'in', athleteIds)
      .where('relationship', '=', 'guardian')
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (
      !staffAccountIds.has(context.actor.accountId) &&
      !memberIds.includes(context.actor.accountId) &&
      !guardianActor &&
      !(await activeOrgRoles(trx, context)).some((role) =>
        ['owner', 'admin', 'communications', 'director'].includes(role),
      )
    )
      throw new ChatPermissionError(
        'Only a team member or organization staff can open this conversation',
      );
    const minorPeople = roster
      .filter((person) => (rosterAgeById.get(person.id) ?? 18) < 18)
      .map((person) => ({
        id: person.id,
        dateOfBirth: dateOnly(person.date_of_birth),
      }));
    const safe = await enforceSafeSport(
      trx,
      context.orgId,
      'team',
      context.actor.accountId,
      [...new Set([...memberIds, context.actor.accountId])],
      now,
      minorPeople,
    );
    const guardianIds = new Set(safe.result.guardianAdditions);
    const finalIds = [
      ...new Set([
        ...memberIds,
        context.actor.accountId,
        ...safe.result.guardianAdditions,
      ]),
    ];
    const conversation =
      existing ??
      (await trx
        .insertInto('conversations')
        .values({
          id: randomUUID(),
          org_id: context.orgId,
          kind: 'team',
          team_season_id: teamSeasonId,
          title: null,
          created_by: context.actor.accountId,
        })
        .returningAll()
        .executeTakeFirstOrThrow());
    await synchronizeConversationMembers(
      trx,
      context,
      conversation.id,
      finalIds,
      guardianIds,
      conversation.created_by,
      now,
      !existing,
      'team',
      teamSeasonId,
    );
    return {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      teamSeasonId: conversation.team_season_id,
      guardianCopied: safe.result.guardianCopied,
      unreadCount: 0,
      lastMessageAt: null,
    };
  });
}

export async function ensureTeamStaffConversation(
  context: OrgContext,
  teamSeasonId: string,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireActiveOrgActor(trx, context);
    const season = await trx
      .selectFrom('team_seasons as season')
      .innerJoin('teams as team', (join) =>
        join
          .onRef('team.id', '=', 'season.team_id')
          .onRef('team.org_id', '=', 'season.org_id'),
      )
      .select(['season.id', 'team.name'])
      .where('season.org_id', '=', context.orgId)
      .where('season.id', '=', teamSeasonId)
      .where('season.status', '=', 'active')
      .executeTakeFirst();
    if (!season) throw new ChatAccessError('Team staff conversation not found');
    const staff = await trx
      .selectFrom('team_staff')
      .select('person_id')
      .where('org_id', '=', context.orgId)
      .where('team_season_id', '=', teamSeasonId)
      .where('status', '=', 'active')
      .execute();
    const personIds = [...new Set(staff.map((item) => item.person_id))];
    const selfLinks = personIds.length
      ? await trx
          .selectFrom('person_account_links')
          .select(['person_id', 'account_id'])
          .where('org_id', '=', context.orgId)
          .where('person_id', 'in', personIds)
          .where('relationship', '=', 'self')
          .where('revoked_at', 'is', null)
          .execute()
      : [];
    const staffAccounts = [...new Set(selfLinks.map((row) => row.account_id))];
    const roles = await activeOrgRoles(trx, context);
    const orgModerator = roles.some((role) =>
      ['owner', 'admin', 'director', 'compliance'].includes(role),
    );
    if (!staffAccounts.includes(context.actor.accountId) && !orgModerator)
      throw new ChatPermissionError(
        'Only team staff can open this conversation',
      );
    const existing = await trx
      .selectFrom('conversations')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('kind', '=', 'team_staff')
      .where('team_season_id', '=', teamSeasonId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    const memberIds = [...new Set([...staffAccounts, context.actor.accountId])];
    await validateAccountTargets(trx, context.orgId, memberIds);
    const safe = await enforceSafeSport(
      trx,
      context.orgId,
      'team',
      context.actor.accountId,
      memberIds,
      now,
    );
    const guardianIds = new Set(safe.result.guardianAdditions);
    const finalIds = [...new Set([...memberIds, ...guardianIds])];
    const conversation =
      existing ??
      (await trx
        .insertInto('conversations')
        .values({
          id: randomUUID(),
          org_id: context.orgId,
          kind: 'team_staff',
          team_season_id: teamSeasonId,
          title: `${season.name} staff`,
          created_by: context.actor.accountId,
        })
        .returningAll()
        .executeTakeFirstOrThrow());
    await synchronizeConversationMembers(
      trx,
      context,
      conversation.id,
      finalIds,
      guardianIds,
      conversation.created_by,
      now,
      !existing,
      'team_staff',
      teamSeasonId,
    );
    return {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      teamSeasonId: conversation.team_season_id,
      guardianCopied: guardianIds.size > 0,
      muted: false,
      unreadCount: 0,
      lastMessageAt: null,
    };
  });
}

export async function listConversations(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireActiveOrgActor(trx, context);
    const memberships = await trx
      .selectFrom('conversation_members')
      .select(['conversation_id', 'last_read_at'])
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('revoked_at', 'is', null)
      .execute();
    if (!memberships.length) return { items: [] };
    const query = await sql<{
      id: string;
      kind: string;
      title: string | null;
      team_season_id: string | null;
      guardian_copied: boolean;
      muted: boolean;
      last_read_at: Date | null;
    }>`
      SELECT conversation.id, conversation.kind, conversation.title, conversation.team_season_id, member.guardian_copied, member.muted, member.last_read_at
      FROM conversations AS conversation
      INNER JOIN conversation_members AS member ON member.org_id = conversation.org_id AND member.conversation_id = conversation.id
      WHERE conversation.org_id = ${context.orgId} AND member.account_id = ${context.actor.accountId} AND member.revoked_at IS NULL AND conversation.archived_at IS NULL
      ORDER BY conversation.updated_at DESC
    `.execute(trx);
    const rows = query.rows;
    const items = [];
    for (const row of rows) {
      const latest = await trx
        .selectFrom('chat_messages')
        .select(['id', 'created_at'])
        .where('org_id', '=', context.orgId)
        .where('conversation_id', '=', row.id)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      const unread = await trx
        .selectFrom('chat_messages')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('org_id', '=', context.orgId)
        .where('conversation_id', '=', row.id)
        .where('author_account_id', '!=', context.actor.accountId)
        .where((eb) =>
          row.last_read_at
            ? eb('created_at', '>', row.last_read_at)
            : eb('id', 'is not', null),
        )
        .executeTakeFirstOrThrow();
      items.push({
        id: row.id,
        kind: row.kind,
        title: row.title,
        teamSeasonId: row.team_season_id,
        guardianCopied: row.guardian_copied,
        muted: row.muted,
        unreadCount: unread.count,
        lastMessageAt: latest?.created_at.toISOString() ?? null,
      });
    }
    return { items };
  });
}

export async function listChatMemberOptions(
  context: OrgContext,
  search: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireActiveOrgActor(trx, context);
    const roles = await activeOrgRoles(trx, context);
    if (
      !roles.some((role) =>
        ['owner', 'admin', 'communications', 'director'].includes(role),
      )
    )
      throw new ChatPermissionError(
        'Only authorized organization staff can create chat channels',
      );
    const term = search.trim().slice(0, 100);
    const rows = await sql<{ accountId: string; label: string }>`
      SELECT DISTINCT account.id AS "accountId",
        btrim(concat_ws(' ', account.first_name, account.last_name)) AS label
      FROM accounts AS account
      WHERE account.status = 'active'
        AND (
          EXISTS (
            SELECT 1 FROM org_memberships AS membership
            WHERE membership.org_id = ${context.orgId}
              AND membership.account_id = account.id
              AND membership.status = 'active'
          )
          OR EXISTS (
            SELECT 1 FROM person_account_links AS link
            WHERE link.org_id = ${context.orgId}
              AND link.account_id = account.id
              AND link.revoked_at IS NULL
          )
        )
        AND (
          ${term} = '' OR
          concat_ws(' ', account.first_name, account.last_name, account.email)
            ILIKE ${`%${term}%`}
        )
      ORDER BY label, account.id
      LIMIT 100
    `.execute(trx);
    return {
      items: rows.rows.map((row) => ({
        accountId: row.accountId,
        label: row.label || 'Organization member',
      })),
    };
  });
}

export async function getChatAttachmentCapabilities(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireActiveOrgActor(trx, context);
    const membership = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    const roles = await activeOrgRoles(trx, context);
    return {
      // Keep the portal's controls aligned with the current Files module:
      // uploads require an active organization membership and owner, admin,
      // or registrar role; internal chat files are downloadable by members.
      canUpload:
        Boolean(membership) &&
        roles.some((role) => ['owner', 'admin', 'registrar'].includes(role)),
      canDownload: Boolean(membership),
    };
  });
}

export async function listAvailableTeams(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireActiveOrgActor(trx, context);
    const selfLinks = await trx
      .selectFrom('person_account_links')
      .select('person_id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('relationship', '=', 'self')
      .where('revoked_at', 'is', null)
      .execute();
    const guardianLinks = await trx
      .selectFrom('person_account_links')
      .select('person_id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('relationship', '=', 'guardian')
      .where('revoked_at', 'is', null)
      .execute();
    const personIds = [
      ...new Set([...selfLinks, ...guardianLinks].map((row) => row.person_id)),
    ];
    const roles = await activeOrgRoles(trx, context);
    const hasOrgStaffAccess = roles.some((role) =>
      ['owner', 'admin', 'communications', 'director'].includes(role),
    );
    const staffIds = hasOrgStaffAccess
      ? (
          await trx
            .selectFrom('team_seasons')
            .select('id')
            .where('org_id', '=', context.orgId)
            .where('status', '=', 'active')
            .execute()
        ).map((row) => row.id)
      : personIds.length
        ? (
            await trx
              .selectFrom('team_staff')
              .select('team_season_id')
              .where('org_id', '=', context.orgId)
              .where('person_id', 'in', personIds)
              .where('status', '=', 'active')
              .execute()
          ).map((row) => row.team_season_id)
        : [];
    const rosterIds = personIds.length
      ? (
          await trx
            .selectFrom('roster_entries')
            .select('team_season_id')
            .where('org_id', '=', context.orgId)
            .where('person_id', 'in', personIds)
            .where('status', 'in', ['active', 'injured', 'suspended'])
            .execute()
        ).map((row) => row.team_season_id)
      : [];
    const ids = [...new Set([...staffIds, ...rosterIds])];
    if (!ids.length) return { items: [] };
    const rows = await trx
      .selectFrom('team_seasons as season')
      .innerJoin('teams as team', (join) =>
        join
          .onRef('team.id', '=', 'season.team_id')
          .onRef('team.org_id', '=', 'season.org_id'),
      )
      .innerJoin('programs as program', (join) =>
        join
          .onRef('program.id', '=', 'season.program_id')
          .onRef('program.org_id', '=', 'season.org_id'),
      )
      .select([
        'season.id',
        'season.display_name',
        'team.name as team_name',
        'program.name as program_name',
      ])
      .where('season.org_id', '=', context.orgId)
      .where('season.id', 'in', ids)
      .orderBy('team.name')
      .execute();
    const staffSeasonIds = new Set(staffIds);
    return {
      items: rows.map((row) => ({
        teamSeasonId: row.id,
        label: `${row.display_name || row.team_name} · ${row.program_name}`,
        staffAccess: staffSeasonIds.has(row.id) || hasOrgStaffAccess,
      })),
    };
  });
}

async function ensureFileAttachments(
  trx: OrgTransaction,
  orgId: string,
  fileIds: readonly string[],
  now: Date,
) {
  if (!fileIds.length) return [] as Array<{ fileId: string; mime: string }>;
  const uniqueIds = [...new Set(fileIds)];
  const files = await trx
    .selectFrom('files')
    .select([
      'id',
      'mime',
      'sensitivity',
      'purpose',
      'upload_state',
      'deleted_at',
      'expires_at',
    ])
    .where('org_id', '=', orgId)
    .where('id', 'in', uniqueIds)
    .execute();
  if (
    files.length !== uniqueIds.length ||
    files.some(
      (file) =>
        !['public', 'internal'].includes(file.sensitivity) ||
        !['image', 'document'].includes(file.purpose) ||
        !(file.mime.startsWith('image/') || file.mime === 'application/pdf') ||
        file.upload_state !== 'complete' ||
        file.deleted_at ||
        file.expires_at <= now,
    )
  )
    throw new ChatAccessError('One or more chat attachments are unavailable');
  return files.map((file) => ({ fileId: file.id, mime: file.mime }));
}

export async function sendChatMessage(
  context: OrgContext,
  conversationId: string,
  input: { body: string; attachments: readonly string[] },
  dependencies: ChatDependencies,
  now = dependencies.now?.() ?? new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const messageId = randomUUID();
  if (!dependencies.notifications) {
    const recipients = await runWithOrg(context, async (trx) => {
      const membership = await requireConversationMember(
        trx,
        context,
        conversationId,
      );
      if (membership.role === 'read_only')
        throw new ChatPermissionError(
          'This announcement conversation is read-only for members',
        );
      const members = await trx
        .selectFrom('conversation_members')
        .select('account_id')
        .where('org_id', '=', context.orgId)
        .where('conversation_id', '=', conversationId)
        .where('revoked_at', 'is', null)
        .execute();
      return members.filter(
        (member) => member.account_id !== context.actor.accountId,
      );
    });
    if (recipients.length)
      throw new ChatIntegrationUnavailableError(
        'Track B notifications SSE integration is not mounted',
      );
  }
  const targetAccounts = await runWithOrg(context, async (trx) => {
    const membership = await requireConversationMember(
      trx,
      context,
      conversationId,
    );
    if (membership.role === 'read_only')
      throw new ChatPermissionError(
        'This announcement conversation is read-only for members',
      );
    const members = await trx
      .selectFrom('conversation_members')
      .select('account_id')
      .where('org_id', '=', context.orgId)
      .where('conversation_id', '=', conversationId)
      .where('revoked_at', 'is', null)
      .execute();
    const accountIds = members.map((member) => member.account_id);
    const safe = await enforceSafeSport(
      trx,
      context.orgId,
      'message',
      context.actor.accountId,
      accountIds,
      now,
    );
    const guardianIds = new Set(safe.result.guardianAdditions);
    if (
      !dependencies.notifications &&
      (accountIds.some((id) => id !== context.actor.accountId) ||
        guardianIds.size > 0)
    )
      throw new ChatIntegrationUnavailableError(
        'Track B notifications SSE integration is not mounted',
      );
    if (guardianIds.size)
      await writeConversationMembers(
        trx,
        context.orgId,
        conversationId,
        [...guardianIds],
        guardianIds,
        context.actor.accountId,
      );
    const attachments = await ensureFileAttachments(
      trx,
      context.orgId,
      input.attachments,
      now,
    );
    const parsed = await trx
      .insertInto('chat_messages')
      .values({
        id: messageId,
        org_id: context.orgId,
        conversation_id: conversationId,
        author_account_id: context.actor.accountId,
        body: input.body.trim(),
        attachments: JSON.stringify(attachments) as unknown as Json,
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('conversations')
      .set({ version: sql`version + 1` })
      .where('org_id', '=', context.orgId)
      .where('id', '=', conversationId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'chat.message.create',
      entityType: 'chat_message',
      entityId: messageId,
      changes: {
        conversation_id: { tier: 'internal', after: conversationId },
        body: { tier: 'internal', after: '[message]' },
        guardian_copied: { tier: 'internal', after: guardianIds.size },
      },
    });
    return {
      parsed,
      recipients: [
        ...new Set(
          [...accountIds, ...guardianIds].filter(
            (id) => id !== context.actor.accountId,
          ),
        ),
      ],
      guardianCopied: guardianIds.size > 0,
    };
  });
  for (const accountId of targetAccounts.recipients)
    await dependencies.notifications?.({
      context,
      accountId,
      conversationId,
      messageId,
    });
  return {
    id: targetAccounts.parsed.id,
    conversationId,
    createdAt: targetAccounts.parsed.created_at.toISOString(),
    guardianCopied: targetAccounts.guardianCopied,
  };
}

export async function listMessages(
  context: OrgContext,
  conversationId: string,
  input: { limit: number; cursor?: string },
  runWithOrg: typeof withOrg = withOrg,
) {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    throw new RangeError('Message page limit must be 1–100');
  return runWithOrg(context, async (trx) => {
    const membership = await trx
      .selectFrom('conversation_members')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('conversation_id', '=', conversationId)
      .where('account_id', '=', context.actor.accountId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    const roles = membership ? [] : await activeOrgRoles(trx, context);
    const moderationView =
      !membership &&
      roles.some((role) => ['owner', 'admin', 'compliance'].includes(role));
    if (!membership && !moderationView)
      throw new ChatAccessError('Conversation not found');
    let query = trx
      .selectFrom('chat_messages')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('conversation_id', '=', conversationId);
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor, 'created_at');
      const createdAt = new Date(String(cursor.value));
      if (Number.isNaN(createdAt.valueOf()))
        throw new RangeError('Invalid message cursor');
      query = query.where((eb) =>
        eb.or([
          eb('created_at', '<', createdAt),
          eb.and([eb('created_at', '=', createdAt), eb('id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit + 1)
      .execute();
    const page = pageFromRows(rows, input.limit, (row) => ({
      sort: 'created_at',
      value: row.created_at.toISOString(),
      id: row.id,
    }));
    const authorIds = [
      ...new Set(page.items.map((row) => row.author_account_id)),
    ];
    const authors = authorIds.length
      ? await trx
          .selectFrom('accounts')
          .select(['id', 'first_name', 'last_name'])
          .where('id', 'in', authorIds)
          .execute()
      : [];
    const authorNames = new Map(
      authors.map((author) => [
        author.id,
        `${author.first_name} ${author.last_name}`.trim(),
      ]),
    );
    const items = [];
    for (const row of page.items) {
      const receipts = await trx
        .selectFrom('conversation_members')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('org_id', '=', context.orgId)
        .where('conversation_id', '=', conversationId)
        .where('revoked_at', 'is', null)
        .where('account_id', '!=', row.author_account_id)
        .where('last_read_at', '>=', row.created_at)
        .executeTakeFirstOrThrow();
      const attachments = Array.isArray(row.attachments)
        ? (row.attachments as unknown as Array<{
            fileId: string;
            mime: string;
          }>)
        : [];
      items.push(
        chatMessageSchema.parse({
          id: row.id,
          conversationId,
          authorAccountId: row.author_account_id,
          authorName:
            authorNames.get(row.author_account_id) ?? 'Organization member',
          body:
            row.deleted_at && !moderationView ? 'Message removed' : row.body,
          attachments: row.deleted_at ? [] : attachments,
          editedAt: row.edited_at?.toISOString() ?? null,
          deletedAt: row.deleted_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
          readByCount: receipts.count,
          version: row.version,
        }),
      );
    }
    return chatMessageListSchema.parse({ items, nextCursor: page.nextCursor });
  });
}

export async function markConversationRead(
  context: OrgContext,
  conversationId: string,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireConversationMember(trx, context, conversationId);
    await trx
      .updateTable('conversation_members')
      .set({ last_read_at: now })
      .where('org_id', '=', context.orgId)
      .where('conversation_id', '=', conversationId)
      .where('account_id', '=', context.actor.accountId)
      .where('revoked_at', 'is', null)
      .execute();
    const members = await trx
      .selectFrom('conversation_members')
      .select('account_id')
      .where('org_id', '=', context.orgId)
      .where('conversation_id', '=', conversationId)
      .where('revoked_at', 'is', null)
      .where('account_id', '!=', context.actor.accountId)
      .execute();
    const read = members.length
      ? await trx
          .selectFrom('conversation_members')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('org_id', '=', context.orgId)
          .where('conversation_id', '=', conversationId)
          .where('revoked_at', 'is', null)
          .where('account_id', '!=', context.actor.accountId)
          .where('last_read_at', 'is not', null)
          .executeTakeFirstOrThrow()
      : { count: 0 };
    await appendAuditEvent(trx, context, {
      action: 'chat.conversation.read',
      entityType: 'conversation',
      entityId: conversationId,
    });
    return { updatedAt: now.toISOString(), readByCount: read.count };
  });
}

export async function setConversationMuted(
  context: OrgContext,
  conversationId: string,
  muted: boolean,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireConversationMember(trx, context, conversationId);
    await trx
      .updateTable('conversation_members')
      .set({ muted })
      .where('org_id', '=', context.orgId)
      .where('conversation_id', '=', conversationId)
      .where('account_id', '=', context.actor.accountId)
      .where('revoked_at', 'is', null)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'chat.conversation.mute',
      entityType: 'conversation',
      entityId: conversationId,
      changes: { muted: { tier: 'internal', after: muted } },
    });
    return { conversationId, muted };
  });
}

export async function editMessage(
  context: OrgContext,
  conversationId: string,
  messageId: string,
  body: string,
  expectedVersion: number,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireConversationMember(trx, context, conversationId);
    const message = await trx
      .selectFrom('chat_messages')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('conversation_id', '=', conversationId)
      .where('id', '=', messageId)
      .executeTakeFirst();
    if (!message || message.deleted_at)
      throw new ChatAccessError('Message not found');
    if (message.author_account_id !== context.actor.accountId)
      throw new ChatPermissionError('Only the author can edit this message');
    if (message.created_at.getTime() + 15 * 60_000 < now.getTime())
      throw new ChatPermissionError(
        'Messages can only be edited for 15 minutes',
      );
    if (message.version !== expectedVersion)
      throw new ChatConflictError('Message version is stale');
    const updated = await trx
      .updateTable('chat_messages')
      .set({ body: body.trim(), edited_at: now, version: expectedVersion + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', messageId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new ChatConflictError('Message version is stale');
    await appendAuditEvent(trx, context, {
      action: 'chat.message.edit',
      entityType: 'chat_message',
      entityId: messageId,
      changes: {
        body: { tier: 'internal', before: '[message]', after: '[message]' },
      },
    });
    return {
      id: updated.id,
      body: updated.body,
      editedAt: now.toISOString(),
      version: updated.version,
    };
  });
}

export async function softDeleteMessage(
  context: OrgContext,
  conversationId: string,
  messageId: string,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireConversationMember(trx, context, conversationId);
    const message = await trx
      .selectFrom('chat_messages')
      .select(['author_account_id', 'deleted_at'])
      .where('org_id', '=', context.orgId)
      .where('conversation_id', '=', conversationId)
      .where('id', '=', messageId)
      .executeTakeFirst();
    if (!message) throw new ChatAccessError('Message not found');
    const roles = await activeOrgRoles(trx, context);
    const moderator = roles.some((role) =>
      ['owner', 'admin', 'compliance'].includes(role),
    );
    if (message.author_account_id !== context.actor.accountId && !moderator)
      throw new ChatPermissionError(
        'Only the author or a moderator can hide this message',
      );
    if (message.deleted_at)
      return { id: messageId, deletedAt: message.deleted_at.toISOString() };
    await trx
      .updateTable('chat_messages')
      .set({
        deleted_at: now,
        deleted_by: context.actor.accountId,
        version: sql`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', messageId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'chat.message.soft_delete',
      entityType: 'chat_message',
      entityId: messageId,
    });
    return { id: messageId, deletedAt: now.toISOString() };
  });
}

export async function reportMessage(
  context: OrgContext,
  conversationId: string,
  messageId: string,
  input: { reason: string; details?: string },
  encryption: EncryptionKeys,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireConversationMember(trx, context, conversationId);
    const message = await trx
      .selectFrom('chat_messages')
      .select(['id', 'body', 'author_account_id'])
      .where('org_id', '=', context.orgId)
      .where('conversation_id', '=', conversationId)
      .where('id', '=', messageId)
      .executeTakeFirst();
    if (!message) throw new ChatAccessError('Message not found');
    const duplicateRows = await sql<{
      id: string;
      incident_report_id: string;
      status: string;
    }>`SELECT id, incident_report_id, status FROM chat_reports WHERE org_id = ${context.orgId} AND message_id = ${messageId} AND reporter_account_id = ${context.actor.accountId}`.execute(
      trx,
    );
    const duplicate = duplicateRows.rows[0];
    if (duplicate)
      return {
        id: duplicate.id,
        incidentReportId: duplicate.incident_report_id,
        status: duplicate.status,
      };
    const members = await trx
      .selectFrom('conversation_members')
      .select('account_id')
      .where('org_id', '=', context.orgId)
      .where('conversation_id', '=', conversationId)
      .where('revoked_at', 'is', null)
      .execute();
    const people = members.length
      ? await trx
          .selectFrom('person_account_links')
          .select('person_id')
          .where('org_id', '=', context.orgId)
          .where(
            'account_id',
            'in',
            members.map((row) => row.account_id),
          )
          .where('relationship', '=', 'self')
          .where('revoked_at', 'is', null)
          .execute()
      : [];
    const incidentId = randomUUID();
    const reportId = randomUUID();
    const incidentBody = Buffer.from(
      JSON.stringify({
        messageId,
        conversationId,
        reportReason: input.reason,
        reportDetails: input.details ?? null,
        originalMessage: message.body,
      }),
    );
    await trx
      .insertInto('incident_reports')
      .values({
        id: incidentId,
        org_id: context.orgId,
        category: 'safesport_concern',
        occurred_at: now,
        event_id: null,
        people_involved: [...new Set(people.map((person) => person.person_id))],
        narrative_enc: encryptRestricted(incidentBody, encryption),
        reported_by: context.actor.accountId,
        restricted: true,
        status: 'open',
      })
      .execute();
    await sql`INSERT INTO chat_reports(id, org_id, message_id, reporter_account_id, reason, status, incident_report_id) VALUES (${reportId}, ${context.orgId}, ${messageId}, ${context.actor.accountId}, ${input.reason}, 'open', ${incidentId})`.execute(
      trx,
    );
    await trx
      .updateTable('chat_messages')
      .set({
        reported_count: sql`reported_count + 1`,
        version: sql`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', messageId)
      .execute();
    await appendAuditEvent(trx, context, {
      action: 'chat.message.report',
      entityType: 'chat_report',
      entityId: reportId,
      changes: {
        incident_report_id: { tier: 'restricted', after: incidentId },
        reason: { tier: 'restricted', after: input.reason },
      },
    });
    return {
      id: reportId,
      incidentReportId: incidentId,
      status: 'open' as const,
    };
  });
}

export async function moderationReports(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireModerationRole(trx, context);
    const result = await sql<{
      id: string;
      incident_report_id: string;
      message_id: string;
      reporter_account_id: string;
      reason: string;
      status: string;
      created_at: Date;
      conversation_id: string;
      version: number;
    }>`
      SELECT report.id, report.incident_report_id, report.message_id, report.reporter_account_id, report.reason, report.status, report.created_at, report.version, message.conversation_id
      FROM chat_reports AS report INNER JOIN chat_messages AS message ON message.org_id = report.org_id AND message.id = report.message_id
      WHERE report.org_id = ${context.orgId} ORDER BY report.created_at DESC LIMIT 200
    `.execute(trx);
    return {
      items: result.rows.map((row) => ({
        reportId: row.id,
        incidentReportId: row.incident_report_id,
        messageId: row.message_id,
        conversationId: row.conversation_id,
        reportedBy: row.reporter_account_id,
        reason: row.reason,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        version: row.version,
      })),
    };
  });
}

export async function updateReportStatus(
  context: OrgContext,
  reportId: string,
  status: 'reviewing' | 'resolved' | 'dismissed',
  expectedVersion: number,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireModerationRole(trx, context);
    const updatedResult = await sql<{
      id: string;
      incident_report_id: string;
      status: string;
      version: number;
    }>`UPDATE chat_reports SET status = ${status}, version = version + 1 WHERE org_id = ${context.orgId} AND id = ${reportId} AND version = ${expectedVersion} RETURNING id, incident_report_id, status, version`.execute(
      trx,
    );
    const updated = updatedResult.rows[0];
    if (!updated) throw new ChatConflictError('Report changed or not found');
    await appendAuditEvent(trx, context, {
      action: 'chat.report.moderate',
      entityType: 'chat_report',
      entityId: reportId,
      changes: { status: { tier: 'restricted', after: status } },
    });
    return {
      id: updated.id,
      incidentReportId: updated.incident_report_id,
      status: updated.status,
      version: updated.version,
    };
  });
}

export async function listPersonMessageHistory(
  context: OrgContext,
  personId: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireActiveOrgActor(trx, context);
    const roles = await activeOrgRoles(trx, context);
    if (
      !roles.some((role) =>
        [
          'owner',
          'admin',
          'communications',
          'director',
          'registrar',
          'compliance',
        ].includes(role),
      )
    )
      throw new ChatPermissionError('Communication history access is required');
    const deliveries = await trx
      .selectFrom('message_deliveries as delivery')
      .leftJoin('message_campaigns as campaign', (join) =>
        join
          .onRef('campaign.id', '=', 'delivery.campaign_id')
          .onRef('campaign.org_id', '=', 'delivery.org_id'),
      )
      .select([
        'delivery.id',
        'delivery.campaign_id',
        'delivery.channel',
        'delivery.status',
        'delivery.address',
        'delivery.created_at',
        'delivery.sent_at',
        'delivery.delivered_at',
        'campaign.subject',
        'delivery.recipient_account_id',
      ])
      .where('delivery.org_id', '=', context.orgId)
      .where('delivery.person_id', '=', personId)
      .orderBy('delivery.created_at', 'desc')
      .limit(200)
      .execute();
    return {
      items: deliveries.map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        title: row.subject ?? 'Message',
        channel: row.channel,
        status: row.status,
        recipientAccountId: row.recipient_account_id,
        createdAt: row.created_at.toISOString(),
        sentAt: row.sent_at?.toISOString() ?? null,
        deliveredAt: row.delivered_at?.toISOString() ?? null,
      })),
    };
  });
}

export async function listHouseholdMessageHistory(
  context: OrgContext,
  householdId: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await requireActiveOrgActor(trx, context);
    const roles = await activeOrgRoles(trx, context);
    if (
      !roles.some((role) =>
        [
          'owner',
          'admin',
          'communications',
          'director',
          'registrar',
          'compliance',
        ].includes(role),
      )
    )
      throw new ChatPermissionError('Communication history access is required');
    const household = await trx
      .selectFrom('households')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', householdId)
      .executeTakeFirst();
    if (!household) throw new ChatAccessError('Household not found');
    const members = await trx
      .selectFrom('household_members')
      .select('person_id')
      .where('org_id', '=', context.orgId)
      .where('household_id', '=', householdId)
      .where('removed_at', 'is', null)
      .execute();
    const personIds = [...new Set(members.map((member) => member.person_id))];
    if (!personIds.length) return { items: [] };
    const accounts = await trx
      .selectFrom('person_account_links')
      .select('account_id')
      .where('org_id', '=', context.orgId)
      .where('person_id', 'in', personIds)
      .where('revoked_at', 'is', null)
      .execute();
    const accountIds = [
      ...new Set(accounts.map((account) => account.account_id)),
    ];
    const deliveries = await trx
      .selectFrom('message_deliveries as delivery')
      .leftJoin('message_campaigns as campaign', (join) =>
        join
          .onRef('campaign.id', '=', 'delivery.campaign_id')
          .onRef('campaign.org_id', '=', 'delivery.org_id'),
      )
      .select([
        'delivery.id',
        'delivery.campaign_id',
        'delivery.channel',
        'delivery.status',
        'delivery.created_at',
        'delivery.sent_at',
        'delivery.delivered_at',
        'campaign.subject',
        'delivery.recipient_account_id',
      ])
      .where('delivery.org_id', '=', context.orgId)
      .where((expression) =>
        expression.or([
          expression('delivery.person_id', 'in', personIds),
          ...(accountIds.length
            ? [
                expression.and([
                  expression('delivery.recipient_account_id', 'in', accountIds),
                  expression('delivery.person_id', 'is', null),
                ]),
              ]
            : []),
        ]),
      )
      .orderBy('delivery.created_at', 'desc')
      .limit(200)
      .execute();
    return {
      items: deliveries.map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        title: row.subject ?? 'Message',
        channel: row.channel,
        status: row.status,
        recipientAccountId: row.recipient_account_id,
        createdAt: row.created_at.toISOString(),
        sentAt: row.sent_at?.toISOString() ?? null,
        deliveredAt: row.delivered_at?.toISOString() ?? null,
      })),
    };
  });
}
