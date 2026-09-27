import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { requireVersion } from '../../lib/version-check';
import { appendAuditEvent } from '../audit/service';

import {
  federationConflict,
  federationNotFound,
  federationUnprocessable,
} from './errors';
import {
  assertActiveRelationship,
  getFederationAdminDatabase,
} from './privileged';

export interface FederationDisciplineView {
  id: string;
  memberOrgId: string;
  memberOrgName: string;
  contestId: string | null;
  externalTeamId: string | null;
  teamName: string | null;
  subjectType: 'team' | 'person';
  personLabel: string | null;
  type: string;
  description: string;
  suspensionGames: number | null;
  suspensionUntil: string | null;
  gamesServed: number;
  status: string;
  createdAt: string;
  version: number;
}

function toView(row: {
  id: string;
  member_org_id: string;
  contest_id: string | null;
  external_team_id: string | null;
  subject_type: string;
  person_label: string | null;
  type: string;
  description: string;
  suspension_games: number | null;
  suspension_until: Date | string | null;
  games_served: number;
  status: string;
  created_at: Date;
  version: number;
  member_name?: string | null | undefined;
  team_name?: string | null | undefined;
}): FederationDisciplineView {
  return {
    id: row.id,
    memberOrgId: row.member_org_id,
    memberOrgName: row.member_name ?? 'Member club',
    contestId: row.contest_id,
    externalTeamId: row.external_team_id,
    teamName: row.team_name ?? null,
    subjectType: row.subject_type as 'team' | 'person',
    personLabel: row.person_label,
    type: row.type,
    description: row.description,
    suspensionGames: row.suspension_games,
    suspensionUntil: row.suspension_until
      ? new Date(row.suspension_until).toISOString().slice(0, 10)
      : null,
    gamesServed: row.games_served,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

/** League issues a discipline record against a member-club subject. */
export async function issueFederationDiscipline(
  context: OrgContext,
  input: {
    memberOrgId: string;
    contestId?: string | null | undefined;
    externalTeamId?: string | null | undefined;
    subjectType: 'team' | 'person';
    personRef?: string | null | undefined;
    personLabel?: string | null | undefined;
    type: string;
    description: string;
    suspensionGames?: number | null | undefined;
    suspensionUntil?: string | null | undefined;
  },
): Promise<FederationDisciplineView> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    await assertActiveRelationship(
      trx,
      context.orgId,
      input.memberOrgId,
    );
    if (input.subjectType === 'team') {
      if (!input.externalTeamId)
        throw federationUnprocessable('Team subject requires externalTeamId');
      const team = await trx
        .selectFrom('external_teams')
        .select(['linked_org_id'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.externalTeamId)
        .executeTakeFirst();
      if (!team) throw federationNotFound('External team not found');
      if (team.linked_org_id !== input.memberOrgId)
        throw federationUnprocessable(
          'Team is not linked to that member club',
        );
    } else if (!input.personRef || !input.personLabel) {
      throw federationUnprocessable(
        'Person subject requires personRef and personLabel',
      );
    }
    if (input.contestId) {
      const contest = await trx
        .selectFrom('contests')
        .select('id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.contestId)
        .executeTakeFirst();
      if (!contest) throw federationNotFound('Contest not found');
    }
    const id = newId();
    await trx
      .insertInto('federation_discipline_records')
      .values({
        id,
        org_id: context.orgId,
        member_org_id: input.memberOrgId,
        contest_id: input.contestId ?? null,
        external_team_id:
          input.subjectType === 'team' ? (input.externalTeamId ?? null) : null,
        subject_type: input.subjectType,
        person_ref:
          input.subjectType === 'person' ? (input.personRef ?? null) : null,
        person_label:
          input.subjectType === 'person' ? (input.personLabel ?? null) : null,
        type: input.type,
        description: input.description,
        suspension_games: input.suspensionGames ?? null,
        suspension_until: input.suspensionUntil ?? null,
        status: 'active',
        issued_by: context.actor.accountId,
      })
      .execute();
    const actor = { accountId: context.actor.accountId };
    for (const orgId of [context.orgId, input.memberOrgId]) {
      await appendAuditEvent(trx, { orgId, actor }, {
        action: 'federation.discipline.issued',
        entityType: 'federation_discipline_record',
        entityId: id,
        changes: {
          memberOrgId: { tier: 'internal', after: input.memberOrgId },
          leagueOrgId: { tier: 'internal', after: context.orgId },
          type: { tier: 'internal', after: input.type },
          subjectType: { tier: 'internal', after: input.subjectType },
        },
      });
    }
    const orgName = await trx
      .selectFrom('organizations')
      .select('name')
      .where('id', '=', input.memberOrgId)
      .executeTakeFirst();
    const team = input.externalTeamId
      ? await trx
          .selectFrom('external_teams')
          .select('name')
          .where('org_id', '=', context.orgId)
          .where('id', '=', input.externalTeamId)
          .executeTakeFirst()
      : undefined;
    const row = await trx
      .selectFrom('federation_discipline_records')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return toView({
      ...row,
      member_name: orgName?.name ?? null,
      team_name: team?.name ?? null,
    });
  });
}

/** League lists its federation discipline records. */
export async function listFederationDiscipline(
  database: Kysely<DB>,
  context: OrgContext,
  memberOrgId?: string,
): Promise<FederationDisciplineView[]> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    let query = trx
      .selectFrom('federation_discipline_records as d')
      .leftJoin('external_teams', (join) =>
        join
          .onRef('external_teams.org_id', '=', 'd.org_id')
          .onRef('external_teams.id', '=', 'd.external_team_id'),
      )
      .selectAll('d')
      .select('external_teams.name as team_name')
      .orderBy('d.created_at', 'desc')
      .limit(500);
    if (memberOrgId) query = query.where('d.member_org_id', '=', memberOrgId);
    const rows = await query.execute();
    const memberIds = [...new Set(rows.map((row) => row.member_org_id))];
    const orgNames = memberIds.length
      ? await trx
          .selectFrom('organizations')
          .select(['id', 'name'])
          .where('id', 'in', memberIds)
          .execute()
      : [];
    const nameById = new Map(orgNames.map((row) => [row.id, row.name]));
    return rows.map((row) =>
      toView({ ...row, member_name: nameById.get(row.member_org_id) }),
    );
  });
}

/** League transitions a record: serve_games | appeal | overturn. */
export async function updateFederationDiscipline(
  database: Kysely<DB>,
  context: OrgContext,
  recordId: string,
  input:
    | { action: 'serve_games'; games: number; version: number }
    | { action: 'appeal'; version: number }
    | { action: 'overturn'; version: number },
): Promise<FederationDisciplineView> {
  const withOrg = createWithOrg(database);
  return withOrg(context, async (trx) => {
    const record = await trx
      .selectFrom('federation_discipline_records')
      .selectAll()
      .where('org_id', '=', context.orgId)
      .where('id', '=', recordId)
      .forUpdate()
      .executeTakeFirst();
    if (!record) throw federationNotFound('Record not found');
    requireVersion(record, input.version);
    let nextStatus = record.status;
    let gamesServed = record.games_served;
    if (input.action === 'serve_games') {
      if (record.status !== 'active')
        throw federationConflict('Only active records can accrue games');
      gamesServed = record.games_served + input.games;
      if (
        record.suspension_games !== null &&
        gamesServed >= record.suspension_games
      )
        nextStatus = 'served';
    } else if (input.action === 'appeal') {
      if (record.status !== 'active')
        throw federationConflict('Only active records can be appealed');
      nextStatus = 'appealed';
    } else {
      if (!['active', 'appealed'].includes(record.status))
        throw federationConflict('Record cannot be overturned');
      nextStatus = 'overturned';
    }
    await trx
      .updateTable('federation_discipline_records')
      .set({
        status: nextStatus,
        games_served: gamesServed,
        version: record.version + 1,
      })
      .where('id', '=', record.id)
      .execute();
    await appendAuditEvent(trx, context, {
      action: `federation.discipline.${input.action}`,
      entityType: 'federation_discipline_record',
      entityId: record.id,
      changes: {
        status: { tier: 'internal', before: record.status, after: nextStatus },
        gamesServed: { tier: 'internal', after: gamesServed },
      },
    });
    const member = await trx
      .selectFrom('organizations')
      .select('name')
      .where('id', '=', record.member_org_id)
      .executeTakeFirst();
    const team = record.external_team_id
      ? await trx
          .selectFrom('external_teams')
          .select('name')
          .where('org_id', '=', context.orgId)
          .where('id', '=', record.external_team_id)
          .executeTakeFirst()
      : undefined;
    return toView({
      ...record,
      status: nextStatus,
      games_served: gamesServed,
      version: record.version + 1,
      member_name: member?.name ?? null,
      team_name: team?.name ?? null,
    });
  });
}

/** Club reads league-issued federation records about itself (privileged). */
export async function listMemberFederationDiscipline(
  context: OrgContext,
): Promise<FederationDisciplineView[]> {
  const admin = getFederationAdminDatabase();
  return admin.transaction().execute(async (trx) => {
    const leagueIds = await trx
      .selectFrom('org_relationships')
      .select('parent_org_id')
      .where('child_org_id', '=', context.orgId)
      .where('status', '=', 'active')
      .execute();
    if (!leagueIds.length) return [];
    const parentIds = leagueIds.map((row) => row.parent_org_id);
    const rows = await trx
      .selectFrom('federation_discipline_records as d')
      .leftJoin('external_teams', (join) =>
        join
          .onRef('external_teams.org_id', '=', 'd.org_id')
          .onRef('external_teams.id', '=', 'd.external_team_id'),
      )
      .selectAll('d')
      .select(['d.org_id as league_org_id', 'external_teams.name as team_name'])
      .where('d.member_org_id', '=', context.orgId)
      .where('d.org_id', 'in', parentIds)
      .orderBy('d.created_at', 'desc')
      .limit(500)
      .execute();
    const leagueNames = await trx
      .selectFrom('organizations')
      .select(['id', 'name'])
      .where('id', 'in', parentIds)
      .execute();
    const nameById = new Map(leagueNames.map((row) => [row.id, row.name]));
    const actor = { accountId: context.actor.accountId };
    for (const leagueId of parentIds) {
      await appendAuditEvent(trx, { orgId: leagueId, actor }, {
        action: 'federation.cross_org.read',
        entityType: 'federation_discipline_record',
        entityId: context.orgId,
        changes: {
          dataset: { tier: 'internal', after: 'federation_discipline' },
          requestingOrgId: { tier: 'internal', after: context.orgId },
        },
      });
    }
    await appendAuditEvent(trx, { orgId: context.orgId, actor }, {
      action: 'federation.cross_org.read',
      entityType: 'federation_discipline_record',
      entityId: context.orgId,
      changes: {
        dataset: { tier: 'internal', after: 'federation_discipline' },
        count: { tier: 'internal', after: rows.length },
      },
    });
    return rows.map((row) =>
      toView({
        ...row,
        member_name: nameById.get(row.league_org_id) ?? null,
      }),
    );
  });
}
